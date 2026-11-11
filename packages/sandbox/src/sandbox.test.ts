import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSandbox,
  dockerAvailable,
  ISOLATING_RUNTIMES,
  isIsolating,
  type Sandbox,
  verifyRuntime,
} from "./index.js";

/**
 * Sandbox safety suite (Phase 3 gate). Runs real containers from infra/sandbox. Docker
 * missing is a failure here, not a skip: a skipped safety suite is not a pass (Rule 2).
 */
const IMAGE = process.env.SANDBOX_IMAGE ?? "codesentra/sandbox:test";
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
let sbx: Sandbox;
let work: string;

beforeAll(async () => {
  const missing = await dockerAvailable();
  if (missing) throw new Error(missing);
  if (!process.env.SANDBOX_IMAGE)
    execFileSync("docker", ["build", "-q", "-t", IMAGE, join(ROOT, "infra/sandbox")], {
      stdio: "pipe",
      timeout: 600_000,
    });
  sbx = await createSandbox();
  work = mkdtempSync(join(tmpdir(), "cs-sbx-test-"));
  writeFileSync(join(work, "hello.txt"), "hi");
  chmodSync(work, 0o777);
}, 660_000);
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const run = (command: string[], limits = {}, env = {}) =>
  sbx.run({
    image: IMAGE,
    workdir: work,
    command,
    network: "none",
    limits: { timeoutMs: 60_000, ...limits },
    env,
  });
const py = (code: string, limits = {}) => run(["python", "-c", code], limits);

describe("sandbox safety suite", () => {
  it("records the runtime used", () => {
    expect(["runsc", "runc"]).toContain(sbx.runtime);
  });

  it("sees the scratch copy and can write to it", async () => {
    const r = await run(["sh", "-c", "cat hello.txt && echo out > made.txt && cat made.txt"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hiout\n");
  });

  it("has no network: no connections, no DNS", async () => {
    const tcp = await py("import socket\nsocket.create_connection(('1.1.1.1', 443), timeout=3)");
    expect(tcp.exitCode).not.toBe(0);
    expect(tcp.stderr).toMatch(/Network is unreachable|OSError|timed out/);
    const dns = await py("import socket\nsocket.getaddrinfo('example.com', 443)");
    expect(dns.exitCode).not.toBe(0);
    expect(dns.stderr).toMatch(/gaierror|Temporary failure|Name or service/);
    const ifaces = await run(["sh", "-c", "ls /sys/class/net"]);
    expect(ifaces.stdout.trim()).toBe("lo");
  });

  it("has a read-only root filesystem", async () => {
    const r = await run(["sh", "-c", "touch /usr/local/bin/evil"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Read-only file system/);
  });

  it("runs unprivileged with no capabilities and no privilege escalation", async () => {
    const r = await run(["sh", "-c", "id -u; grep -E '^(CapEff|NoNewPrivs)' /proc/self/status"]);
    expect(r.stdout).toMatch(/^10001\n/);
    expect(r.stdout).toMatch(/CapEff:\s+0000000000000000/);
    expect(r.stdout).toMatch(/NoNewPrivs:\s+1/);
  });

  it("passes no worker environment in (no secrets)", async () => {
    process.env.CS_SANDBOX_CANARY_SECRET = "must-not-leak";
    const r = await run(["sh", "-c", "env"], {}, { ONLY_THIS: "1" });
    expect(r.stdout).not.toContain("must-not-leak");
    expect(r.stdout).not.toMatch(/DATABASE_URL|S3_SECRET|SESSION_SECRET|ANTHROPIC/);
    expect(r.stdout).toContain("ONLY_THIS=1");
  });

  it("kills a command at its timeout", async () => {
    const r = await run(["sleep", "60"], { timeoutMs: 2000 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(20_000);
  });

  it("caps captured output", async () => {
    const r = await py("import sys\nsys.stdout.write('x' * (3 * 1024 * 1024))", {
      maxOutputBytes: 1024 * 1024,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1024 * 1024);
  });

  it("enforces the memory limit (no swap)", async () => {
    const r = await py("b = bytearray(600 * 1024 * 1024)\nprint('allocated')", {
      memoryBytes: 256 * 1024 * 1024,
    });
    expect(r.stdout).not.toContain("allocated");
    expect(r.exitCode).not.toBe(0);
  });

  it("enforces the process limit (fork bombs stop)", async () => {
    const r = await run(
      [
        "sh",
        "-c",
        "for i in $(seq 200); do sleep 5 & done 2>/dev/null; echo spawned $(jobs -p | wc -l)",
      ],
      {
        pids: 32,
        timeoutMs: 30_000,
      },
    );
    const spawned = Number(/spawned (\d+)/.exec(r.stdout)?.[1] ?? "0");
    expect(spawned).toBeLessThan(40);
  });
});

describe("runtime verification (ADR 0032, F-08)", () => {
  it("confirms the runtime by running a container and reports whether it isolates", async () => {
    const check = await verifyRuntime(IMAGE);
    expect(check.ok, JSON.stringify(check)).toBe(true);
    if (check.ok) {
      expect(ISOLATING_RUNTIMES).toContain(check.runtime === "runc" ? "runsc" : check.runtime); // sanity: the set is non-empty
      // In this environment the runtime is runc (gVisor absent), which does not isolate.
      expect(check.isolating).toBe(isIsolating(check.runtime));
      expect(isIsolating("runsc")).toBe(true);
      expect(isIsolating("runc")).toBe(false);
    }
  }, 60_000);

  it("reports a gap, not a throw, when the image cannot start", async () => {
    const check = await verifyRuntime("codesentra/does-not-exist:nope");
    expect(check.ok).toBe(false);
    if (!check.ok)
      expect(check.reason).toMatch(/could not start|not available|No such image|not found|pull/i);
  }, 60_000);

  it("runs under gVisor (runsc) when the dedicated CI gate requires it — positive path", async () => {
    // A no-op everywhere except the `runsc` CI job, which installs gVisor and sets
    // REQUIRE_RUNSC=1. There it closes the re-audit's "positive gVisor path — UNVERIFIED here"
    // gap: the throwaway container really runs under runsc, that runtime isolates untrusted code
    // from the host kernel, and the sandbox this suite exercised also ran under runsc.
    if (process.env.REQUIRE_RUNSC !== "1") return;
    const check = await verifyRuntime(IMAGE);
    expect(check, JSON.stringify(check)).toMatchObject({
      ok: true,
      runtime: "runsc",
      isolating: true,
    });
    expect(sbx.runtime).toBe("runsc");
  }, 60_000);
});
