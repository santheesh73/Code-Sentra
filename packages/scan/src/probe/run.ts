import { chmod, cp, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunResult, Sandbox } from "@codesentra/sandbox";
import { classifyFetchFailure } from "./classify.js";
import { materializeFetchDir, planFetchDir } from "./fetch-dir.js";
import { type ErrorLine, parseErrorLines, parseTestOutput, type TestSummary } from "./parse.js";
import { PROBES, type ProbeName, type ProbePlan } from "./plan.js";
import { checkLockSources, LOCKFILES_BY_MANAGER } from "./sources/index.js";

/** The download cache inside the work tree, copied from the manifest-only fetch (ADR 0030). */
const NODE_CACHE_DIR = ".cs-pm-cache";

/** Snapshot paths, relative, for building the manifest-only download directory. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(dir, "");
  return out;
}

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

/**
 * Checks the lockfile the download will use before anything is fetched (ADR 0030). A
 * source outside the allowed registries is refused, naming the dependency.
 */
async function lockSourceRefusal(sourceDir: string, plan: ProbePlan): Promise<string | null> {
  for (const name of LOCKFILES_BY_MANAGER[plan.packageManager ?? ""] ?? []) {
    const path = join(sourceDir, name);
    const st = await lstat(path).catch(() => null);
    if (!st?.isFile()) continue;
    const why = checkLockSources(name, await readFile(path, "utf8"));
    if (why) return `not downloaded: ${why}`;
  }
  return null;
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
  // Whether the block is a coverage gap (network/environment, or our refusal) rather than a
  // failure of the project: a gap reports the install as skipped, not failed (ADR 0030, F-05).
  let blockedIsGap = false;
  const refused =
    plan.refused ?? (plan.fetch ? await lockSourceRefusal(opts.sourceDir, plan) : null);
  if (refused) {
    fetch.status = "refused";
    fetch.reason = refused;
    blocked = `dependencies were not installed: ${refused}`;
    blockedIsGap = true;
  } else if (plan.fetch) {
    // A manifest-only download runs in a directory holding only the dependency manifests and
    // lockfiles (ADR 0030): no project script or hook is present, so none can run with the
    // network. Its cache is then copied into the work tree for the offline install.
    let fetchWorkdir = work;
    if (plan.fetch.manifestOnly) {
      fetchWorkdir = join(opts.scratchDir, "fetch");
      const paths = await listFiles(opts.sourceDir);
      await materializeFetchDir(opts.sourceDir, fetchWorkdir, planFetchDir(paths));
      await openUp(fetchWorkdir);
    }
    const r = await sandbox.run({
      image,
      workdir: fetchWorkdir,
      command: plan.fetch.command,
      network: "fetch",
      env: plan.fetch.env,
      limits: { timeoutMs: 10 * 60_000 },
    });
    if (plan.fetch.manifestOnly && r.exitCode === 0) {
      await cp(join(fetchWorkdir, NODE_CACHE_DIR), join(work, NODE_CACHE_DIR), {
        recursive: true,
      }).catch(() => {});
      await openUp(work);
    }
    fetch.durationMs = r.durationMs;
    fetch.excerpt = tail(r);
    fetch.reason = plan.fetch.reason;
    fetch.status = r.timedOut ? "timeout" : r.exitCode === 0 ? "pass" : "fail";
    // Our download scripts can refuse once they see what the lockfile or POMs resolve to.
    const refusal = /^codesentra-refused: (.+)$/m.exec(r.stdout)?.[1];
    if (fetch.status === "fail" && refusal) {
      fetch.status = "refused";
      fetch.reason = `not downloaded: ${refusal}`;
      blocked = `dependencies were not installed: ${fetch.reason}`;
    } else if (fetch.status !== "pass") {
      // Classify the failure: a network/environment failure is a coverage gap (Unverified),
      // not a finding against the project; a manifest error is a real install failure (F-05).
      const verdict = classifyFetchFailure(`${r.stdout}\n${r.stderr}`, r.exitCode, r.timedOut);
      fetch.reason = verdict.reason;
      blocked = `dependencies were not installed: ${verdict.reason}`;
      blockedIsGap = verdict.kind === "infra";
    }
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
          ...skipped(s.name, blocked, blockedIsGap ? "skipped" : "fail"),
          excerpt: fetch.excerpt,
        });
        if (!blockedIsGap) blocked = "install failed";
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
      env: s.env,
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
