import { chmod, cp, lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunResult, Sandbox } from "@codesentra/sandbox";
import { type ErrorLine, parseErrorLines, parseTestOutput, type TestSummary } from "./parse.js";
import { PROBES, type ProbeName, type ProbePlan } from "./plan.js";

export type ProbeStatus = "pass" | "fail" | "timeout" | "not_applicable" | "skipped";

export interface ProbeResult {
  name: ProbeName;
  status: ProbeStatus;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  /** Why it did not run (skipped / not_applicable), or what went wrong. */
  reason: string | null;
  /** The last part of stdout + stderr (redacted of nothing: project output only). */
  excerpt: string;
  errors: ErrorLine[];
  tests: TestSummary | null;
  truncated: boolean;
}

export interface ProbeRun {
  runtime: string;
  results: ProbeResult[];
  fetch: {
    status: "pass" | "fail" | "timeout" | "refused" | "none";
    durationMs: number;
    reason: string | null;
    excerpt: string;
  };
}

/** The whole probe stage gets 10 minutes of wall clock (Section 8.4). */
export const PROBE_BUDGET_MS = 10 * 60_000;
const EXCERPT = 4000;

const tail = (r: RunResult) => `${r.stdout}\n${r.stderr}`.trim().slice(-EXCERPT);

async function openUp(dir: string): Promise<void> {
  // The sandbox user (uid 10001) must be able to write the scratch copy.
  await chmod(dir, 0o777);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await openUp(p);
    else await chmod(p, (await lstat(p)).mode & 0o100 ? 0o777 : 0o666);
  }
}

/**
 * Runs a probe plan in the sandbox against a fresh scratch copy of the snapshot. The
 * original tree is never mounted. Each step reports pass/fail/timeout with an excerpt,
 * parsed diagnostics and test counts; anything that could not run is `skipped` with a
 * reason (Rule 2).
 */
export async function runProbes(opts: ProbeOptions): Promise<ProbeRun> {
  try {
    return await probe(opts);
  } finally {
    // Files the sandbox wrote belong to its uid (10001). Opening them up from inside lets
    // a non-root worker delete the scratch copy afterwards.
    await opts.sandbox
      .run({
        image: opts.image,
        workdir: join(opts.scratchDir, "work"),
        command: ["sh", "-c", "chmod -R a+rwX /work 2>/dev/null; true"],
        network: "none",
        limits: { timeoutMs: 60_000 },
      })
      .catch(() => {});
  }
}

interface ProbeOptions {
  sandbox: Sandbox;
  image: string;
  sourceDir: string;
  scratchDir: string;
  plan: ProbePlan;
  budgetMs?: number;
}

async function probe(opts: ProbeOptions): Promise<ProbeRun> {
  const { sandbox, image, plan } = opts;
  const budget = opts.budgetMs ?? PROBE_BUDGET_MS;
  const started = performance.now();
  const work = join(opts.scratchDir, "work");
  await cp(opts.sourceDir, work, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !src.endsWith("/.git"),
  });
  for (const p of plan.prepare) {
    if (p.rename) await rename(join(work, p.rename[0]), join(work, p.rename[1])).catch(() => {});
    if (p.write) {
      await mkdir(dirname(join(work, p.write[0])), { recursive: true });
      await writeFile(join(work, p.write[0]), p.write[1]);
    }
  }
  await openUp(work);

  const results: ProbeResult[] = [];
  const skipped = (
    name: ProbeName,
    reason: string,
    status: ProbeStatus = "skipped",
  ): ProbeResult => ({
    name,
    status,
    command: null,
    exitCode: null,
    durationMs: 0,
    reason,
    excerpt: "",
    errors: [],
    tests: null,
    truncated: false,
  });

  const fetch: ProbeRun["fetch"] = { status: "none", durationMs: 0, reason: null, excerpt: "" };
  let blocked: string | null = null;
  if (plan.refused) {
    fetch.status = "refused";
    fetch.reason = plan.refused;
    blocked = `dependencies were not installed: ${plan.refused}`;
  } else if (plan.fetch) {
    const r = await sandbox.run({
      image,
      workdir: work,
      command: plan.fetch.command,
      network: "fetch",
      limits: { timeoutMs: 10 * 60_000 },
    });
    fetch.durationMs = r.durationMs;
    fetch.excerpt = tail(r);
    fetch.reason = plan.fetch.reason;
    fetch.status = r.timedOut ? "timeout" : r.exitCode === 0 ? "pass" : "fail";
    if (fetch.status !== "pass")
      blocked = `dependency download ${fetch.status === "timeout" ? "timed out" : "failed"}`;
  }

  for (const s of plan.steps) {
    if (s.skip) {
      results.push(
        skipped(
          s.name,
          s.skip.reason,
          s.skip.kind === "not_applicable" ? "not_applicable" : "skipped",
        ),
      );
      continue;
    }
    if (blocked) {
      if (s.name === "install") {
        results.push({
          ...skipped(s.name, blocked, fetch.status === "refused" ? "skipped" : "fail"),
          excerpt: fetch.excerpt,
        });
        if (fetch.status !== "refused") blocked = "install failed";
      } else results.push(skipped(s.name, blocked));
      continue;
    }
    const left = budget - (performance.now() - started);
    if (left < 5_000) {
      results.push(skipped(s.name, "the 10-minute probe budget ran out before this step"));
      continue;
    }
    const r = await sandbox.run({
      image,
      workdir: work,
      command: s.command as string[],
      network: "none",
      limits: { timeoutMs: Math.min(s.timeoutMs, left) },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    let status: ProbeStatus = r.timedOut ? "timeout" : r.exitCode === 0 ? "pass" : "fail";
    // A failure the sandbox causes (no compiler, another runtime pinned) is a gap.
    const limit = status === "fail" ? s.gapWhen?.find((g) => g.pattern.test(out)) : undefined;
    if (limit) status = "skipped";
    results.push({
      name: s.name,
      status,
      command: (s.command as string[]).join(" "),
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      reason: limit
        ? limit.reason
        : r.timedOut
          ? `timed out after ${Math.round(Math.min(s.timeoutMs, left) / 1000)} s`
          : null,
      excerpt: tail(r),
      errors: status === "pass" ? [] : parseErrorLines(out),
      tests: s.name === "tests" ? parseTestOutput(out) : null,
      truncated: r.truncated,
    });
    if (s.name === "install" && status !== "pass") blocked = limit?.reason ?? "install failed";
  }
  results.sort((a, b) => PROBES.indexOf(a.name) - PROBES.indexOf(b.name));
  return { runtime: sandbox.runtime, results, fetch };
}
