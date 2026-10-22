import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOG_DIR = join(ROOT, "e2e", "test-results", "logs");

export async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

export function spawnService(
  name: string,
  args: string[],
  env: Record<string, string>,
  cwd = ROOT,
): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = createWriteStream(join(LOG_DIR, `${name}.log`), { flags: "a" });
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

export async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not become ready: ${last}`);
}

export function newEnvBase(): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    EMAIL_TRANSPORT: "outbox",
    EMAIL_OUTBOX_DIR: mkdtempSync(join(tmpdir(), "cs-outbox-")),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** Starts worker-pulse with the stack's env. Tests own its lifecycle. */
export function startWorkerProcess(): ChildProcess {
  const env = JSON.parse(process.env.CS_E2E_ENV ?? "{}") as Record<string, string>;
  return spawnService("worker-pulse", [join(ROOT, "apps/worker-pulse/dist/main.js")], env);
}

/**
 * Starts worker-scan with the stack's env plus the scan settings: the scripted fixture
 * model (TEST ONLY, ADR 0017), the repo's offline OSV snapshot, and the sandbox image.
 */
export function startScanWorkerProcess(sandboxImage: string): ChildProcess {
  const env = JSON.parse(process.env.CS_E2E_ENV ?? "{}") as Record<string, string>;
  const pass = (k: string) => (process.env[k] ? { [k]: process.env[k] as string } : {});
  return spawnService("worker-scan", [join(ROOT, "apps/worker-scan/dist/main.js")], {
    ...env,
    SCAN_TEST_MODEL: "fixture",
    OSV_OFFLINE_DIR: join(ROOT, "fixtures/osv"),
    SANDBOX_IMAGE: sandboxImage,
    SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? "runc",
    ...pass("SANDBOX_FETCH_NETWORK"),
    ...pass("SANDBOX_FETCH_PROXY"),
    ...pass("SANDBOX_FETCH_CA_FILE"),
  });
}

export async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((ok) => {
    child.once("exit", () => ok());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}
