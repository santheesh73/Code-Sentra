import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export type SandboxRuntime = "runsc" | "kata" | "kata-runtime" | "firecracker" | "runc";

/** Runtimes that isolate untrusted code from the host kernel (ADR 0032). */
export const ISOLATING_RUNTIMES: readonly SandboxRuntime[] = [
  "runsc",
  "kata",
  "kata-runtime",
  "firecracker",
];
export const isIsolating = (r: SandboxRuntime) => ISOLATING_RUNTIMES.includes(r);

export interface SandboxLimits {
  cpus: number;
  memoryBytes: number;
  pids: number;
  /** Wall clock for one command. */
  timeoutMs: number;
  /** stdout + stderr captured per command; the rest is dropped and `truncated` set. */
  maxOutputBytes: number;
}

/** Section 8.4: CPU 2, memory 4 GB, output capped at 5 MB. Each command has its own timeout. */
export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryBytes: 4 * 1024 ** 3,
  pids: 1024,
  timeoutMs: 10 * 60_000,
  maxOutputBytes: 5 * 1024 * 1024,
};

/**
 * `none` is the sandbox proper. `fetch` is only for the dependency download step, which
 * runs the package manager with install scripts disabled and never runs project code
 * (ADR 0016); it may be routed through an egress proxy.
 */
export type SandboxNetwork = "none" | "fetch";

export interface FetchNetworkConfig {
  /** Docker network for fetch steps (default "bridge"; "host" where egress needs a host proxy). */
  network: string;
  proxy: string | null;
  /** CA bundle for a TLS-intercepting proxy, mounted read-only. */
  caFile: string | null;
}

export interface RunOptions {
  image: string;
  /** Host directory mounted at /work (a scratch copy of the snapshot, never the original). */
  workdir: string;
  command: string[];
  network: SandboxNetwork;
  limits?: Partial<SandboxLimits>;
  /** Explicit, non-secret variables only; nothing is inherited from the worker. */
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  runtime: SandboxRuntime;
  network: SandboxNetwork;
}

function exec(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((ok) =>
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      (err, stdout, stderr) =>
        ok({
          stdout: String(stdout),
          stderr: String(stderr),
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
        }),
    ),
  );
}

/**
 * The isolating runtime Docker offers, preferring gVisor, then Kata, then Firecracker; runc
 * when none is present. The choice is recorded per run.
 */
export async function detectRuntime(): Promise<SandboxRuntime> {
  const { stdout, code } = await exec("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (code !== 0) throw new Error("docker is not available");
  for (const r of ["runsc", "kata", "kata-runtime", "firecracker"] as const)
    if (new RegExp(`"${r}"`).test(stdout)) return r;
  return "runc";
}

export type RuntimeCheck =
  | { ok: true; runtime: SandboxRuntime; isolating: boolean }
  | { ok: false; reason: string };

/**
 * Confirms the runtime by actually running a throwaway container with it (ADR 0032): parsing
 * `docker info` is not proof the runtime works. Returns the runtime that ran, and whether it
 * isolates untrusted code from the host kernel. A Docker that is down or cannot start the
 * container is reported as not-ok (a coverage gap, never a product failure).
 */
export async function verifyRuntime(image: string): Promise<RuntimeCheck> {
  let runtime: SandboxRuntime;
  try {
    runtime = await detectRuntime();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const name = `cs-rtcheck-${randomBytes(6).toString("hex")}`;
  const { code, stdout, stderr } = await exec("docker", [
    "run",
    "--rm",
    "--name",
    name,
    "--runtime",
    runtime,
    "--network",
    "none",
    image,
    "true",
  ]);
  if (code !== 0)
    return {
      ok: false,
      reason: `the sandbox runtime ${runtime} could not start a container: ${(stderr || stdout || "").trim().slice(-400)}`,
    };
  return { ok: true, runtime, isolating: isIsolating(runtime) };
}

export async function dockerAvailable(): Promise<string | null> {
  const { code, stdout } = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
  return code === 0 ? null : `docker is not available${stdout ? `: ${stdout.trim()}` : ""}`;
}

export interface Sandbox {
  readonly runtime: SandboxRuntime;
  run(opts: RunOptions): Promise<RunResult>;
}

/**
 * Docker sandbox (Rule 5). Every container: no network (except fetch steps), read-only
 * root, all capabilities dropped, no-new-privileges, Docker's default seccomp profile,
 * unprivileged user, pid/CPU/memory limits (no swap), a size-capped /tmp, and only the
 * scratch copy mounted. Nothing from the worker's environment is passed in.
 */
export async function createSandbox(
  fetchNet: FetchNetworkConfig = { network: "bridge", proxy: null, caFile: null },
): Promise<Sandbox> {
  const runtime = await detectRuntime();
  return {
    runtime,
    async run(opts) {
      const limits = { ...DEFAULT_LIMITS, ...opts.limits };
      const name = `cs-sbx-${randomBytes(6).toString("hex")}`;
      const env: Record<string, string> = { ...opts.env };
      const extra: string[] = [];
      if (opts.network === "fetch") {
        extra.push("--network", fetchNet.network);
        if (fetchNet.proxy) {
          for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])
            env[k] = fetchNet.proxy;
        }
        if (fetchNet.caFile) {
          extra.push("-v", `${fetchNet.caFile}:/etc/codesentra-ca.pem:ro`);
          Object.assign(env, {
            NODE_EXTRA_CA_CERTS: "/etc/codesentra-ca.pem",
            PIP_CERT: "/etc/codesentra-ca.pem",
            SSL_CERT_FILE: "/etc/codesentra-ca.pem",
            REQUESTS_CA_BUNDLE: "/etc/codesentra-ca.pem",
          });
        }
      } else {
        extra.push("--network", "none");
      }
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        "--runtime",
        runtime,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,exec,nosuid,size=1g",
        "--tmpfs",
        "/home/sandbox:rw,nosuid,size=512m,uid=10001,gid=10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(limits.pids),
        "--cpus",
        String(limits.cpus),
        "--memory",
        String(limits.memoryBytes),
        "--memory-swap",
        String(limits.memoryBytes),
        "--user",
        "10001:10001",
        "-v",
        `${opts.workdir}:/work:rw`,
        "-w",
        "/work",
        ...extra,
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        opts.image,
        ...opts.command,
      ];
      const started = performance.now();
      return await new Promise<RunResult>((ok) => {
        const child = spawn("docker", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
        let out = "";
        let err = "";
        let bytes = 0;
        let truncated = false;
        const take = (which: "out" | "err") => (chunk: Buffer) => {
          const room = limits.maxOutputBytes - bytes;
          if (room <= 0) {
            truncated = true;
            return;
          }
          const s = chunk.subarray(0, room).toString("utf8");
          if (chunk.length > room) truncated = true;
          bytes += Math.min(chunk.length, room);
          if (which === "out") out += s;
          else err += s;
        };
        child.stdout.on("data", take("out"));
        child.stderr.on("data", take("err"));
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          execFile("docker", ["kill", name], () => {});
        }, limits.timeoutMs);
        child.on("close", (code) => {
          clearTimeout(timer);
          ok({
            exitCode: timedOut ? null : code,
            stdout: out,
            stderr: err,
            durationMs: Math.round(performance.now() - started),
            timedOut,
            truncated,
            runtime,
            network: opts.network,
          });
        });
      });
    },
  };
}
