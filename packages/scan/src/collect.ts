import type { JsonObject } from "@codesentra/core";
import { fanIn, type HistoryStats, hotspots } from "@codesentra/graph";
import type { AuditResult } from "./audit/osv.js";
import type { MapResult } from "./map.js";
import type { ProbeResult, ProbeRun } from "./probe/run.js";
import type { ScanRecorder } from "./recorder.js";
import type { SecretMatch } from "./secrets.js";

/** Outcome of each check, for the claim verifier (Rule 4: no claim may assert a skipped check passed). */
export type CheckOutcome = "pass" | "fail" | "skipped" | "not_applicable";

const manifestOf = (map: MapResult) =>
  map.paths.includes("package.json")
    ? "package.json"
    : (map.paths.find((p) => /^(requirements\.txt|pyproject\.toml)$/.test(p)) ?? ".");

/** Finds the static test case a runner's failing-test name refers to. */
function matchTest(
  map: MapResult,
  failing: string,
): { file: string; line: number; name: string } | null {
  // pytest: path::name or path::Class::name; vitest: "file > suite > name"; RSpec: file:line.
  let file: string | null = null;
  let name = failing;
  // RSpec names the failing example by its own file and line.
  const at = /^(\S+?):(\d+)$/.exec(failing);
  if (at) {
    const f = map.facts.find((x) => x.path === at[1]);
    const t = f?.tests.find((x) => x.line === Number(at[2]));
    if (f && t) return { file: f.path, line: t.line, name: t.name };
  }
  if (failing.includes("::")) {
    const parts = failing.split("::");
    file = parts[0] as string;
    name = parts[parts.length - 1]?.replace(/\[.*\]$/, "") as string;
  } else if (failing.includes(" > ")) {
    const parts = failing.split(" > ");
    if (/\.[cm]?[jt]sx?$/.test(parts[0] as string)) file = parts[0] as string;
    name = parts[parts.length - 1] as string;
  }
  for (const f of map.facts) {
    if (file && f.path !== file) continue;
    const t = f.tests.find((x) => x.name === name.trim());
    if (t) return { file: f.path, line: t.line, name: t.name };
  }
  return null;
}

export function recordProbes(
  rec: ScanRecorder,
  map: MapResult,
  run: ProbeRun,
): Record<string, CheckOutcome> {
  const manifest = manifestOf(map);
  const outcomes: Record<string, CheckOutcome> = {};
  const byName = new Map(run.results.map((r) => [r.name, r]));
  const evOf = new Map<string, string>();
  rec.addEvidence("probe_result", `${manifest}#fetch`, {
    probe: "dependency_download",
    status: run.fetch.status,
    reason: run.fetch.reason,
    duration_ms: run.fetch.durationMs,
    excerpt: run.fetch.excerpt.slice(-2000),
    sandbox_runtime: run.runtime,
  });
  for (const r of run.results) {
    const payload: JsonObject = {
      probe: r.name,
      status: r.status,
      command: r.command,
      exit_code: r.exitCode,
      duration_ms: r.durationMs,
      reason: r.reason,
      excerpt: r.excerpt.slice(-2000),
      errors: r.errors.map((e) => ({ file: e.file, line: e.line, message: e.message })),
      sandbox_runtime: run.runtime,
      network:
        r.name === "install" ? "none (dependencies downloaded in a separate fetch step)" : "none",
      output_truncated: r.truncated,
    };
    if (r.tests)
      Object.assign(payload, {
        runner: r.tests.runner,
        pass: r.tests.pass,
        fail: r.tests.fail,
        skip: r.tests.skip,
        total: r.tests.pass + r.tests.fail + r.tests.skip,
        failing: r.tests.failing,
      });
    evOf.set(r.name, rec.addEvidence("probe_result", `${manifest}#${r.name}`, payload));
    outcomes[r.name] =
      r.status === "pass"
        ? "pass"
        : r.status === "not_applicable"
          ? "not_applicable"
          : r.status === "skipped"
            ? "skipped"
            : "fail";
  }
  // A test run without a readable summary is not a pass (Rule 2).
  const tests = byName.get("tests");
  if (tests?.status === "pass" && !tests.tests) outcomes.tests = "skipped";

  const failEvidence = (r: ProbeResult | undefined) => (r ? (evOf.get(r.name) as string) : "");
  const install = byName.get("install");
  const build = byName.get("build");
  for (const r of [install, build]) {
    if (r?.status === "fail" || r?.status === "timeout") {
      const first = r.errors[0];
      rec.addFinding(
        "BUILD_FAILED",
        failEvidence(r),
        first ? `${first.file}:${first.line}` : `${manifest}#${r.name}`,
        `${r.name === "install" ? "Dependency install" : "The build"} ${r.status === "timeout" ? "timed out" : `failed (exit ${r.exitCode})`}${first ? `: ${first.message}` : ""}.`,
        r.name,
      );
    }
  }
  for (const [name, code] of [
    ["typecheck", "TYPECHECK_ERRORS"],
    ["lint", "LINT_ERRORS"],
  ] as const) {
    const r = byName.get(name);
    if (r?.status !== "fail" && r?.status !== "timeout") continue;
    const files = [...new Map(r.errors.map((e) => [e.file, e])).values()];
    if (!files.length)
      rec.addFinding(
        code,
        failEvidence(r),
        `${manifest}#${name}`,
        `${name} failed (exit ${r.exitCode}).`,
      );
    for (const e of files.slice(0, 20))
      rec.addFinding(
        code,
        failEvidence(r),
        `${e.file}:${e.line}`,
        `${name}: ${e.message} (${e.file}:${e.line}).`,
      );
  }

  if (tests?.tests) {
    const failing = new Set<string>();
    for (const name of tests.tests.failing) {
      const t = matchTest(map, name);
      const key = t ? (map.testEvidence.get(`${t.file}:${t.line}`) as string) : failEvidence(tests);
      if (t) {
        failing.add(`${t.file}:${t.line}`);
        rec.addFinding(
          "TESTS_FAILING",
          key,
          `${t.file}:${t.line}`,
          `Test "${t.name}" fails (${t.file}:${t.line}).`,
          t.name,
        );
      } else {
        rec.addFinding("TESTS_FAILING", key, `${manifest}#tests`, `Test "${name}" fails.`, name);
      }
    }
    if (tests.tests.fail > 0 && tests.tests.failing.length === 0)
      rec.addFinding(
        "TESTS_FAILING",
        failEvidence(tests),
        `${manifest}#tests`,
        `${tests.tests.fail} tests fail.`,
      );
    // Per-test status on the static test evidence.
    for (const [loc, key] of map.testEvidence) {
      const ev = rec.byKey(key);
      if (!ev || ev.payload.status === "skipped") continue;
      ev.payload.status = failing.has(loc)
        ? "fail"
        : tests.tests.fail === 0 || tests.tests.failing.length
          ? "pass"
          : "unknown";
    }
  }
  return outcomes;
}

export function recordAudit(
  rec: ScanRecorder,
  audit: AuditResult,
  source: string,
): { outcome: CheckOutcome; gaps: string[] } {
  const gaps: string[] = [];
  for (const v of audit.vulnerable) {
    const key = rec.addEvidence("dependency_advisory", v.pkg.locator, {
      ecosystem: v.pkg.ecosystem,
      package: v.pkg.name,
      version: v.pkg.version,
      dev: v.pkg.dev,
      source,
      advisories: v.advisories.map((a) => ({
        id: a.id,
        aliases: a.ids,
        severity: a.severity,
        summary: a.summary,
        fixed_versions: a.fixedVersions,
      })),
    });
    const worst = v.advisories[0];
    rec.addFinding(
      "VULNERABLE_DEPENDENCY",
      key,
      v.pkg.locator,
      `${v.pkg.name}@${v.pkg.version} has ${v.advisories.length} known ${v.advisories.length === 1 ? "advisory" : "advisories"} (${v.advisories.map((a) => a.id).join(", ")})${worst?.fixedVersions.length ? `; fixed in ${worst.fixedVersions.join(", ")}` : ""}.`,
      `${v.pkg.ecosystem}:${v.pkg.name}`,
      worst?.severity === "critical" || worst?.severity === "high" ? "error" : "warning",
    );
  }
  if (audit.notChecked.length) {
    const names = audit.notChecked.slice(0, 10).map((n) => n.pkg.name);
    gaps.push(
      `${audit.notChecked.length} packages not checked for advisories (${names.join(", ")}${audit.notChecked.length > 10 ? ", …" : ""}): ${audit.notChecked[0]?.reason}`,
    );
  }
  rec.addEvidence("dependency_advisory", ".", {
    kind: "summary",
    source,
    packages_checked: audit.checked,
    packages_not_checked: audit.notChecked.length,
    vulnerable_packages: audit.vulnerable.length,
  });
  const outcome: CheckOutcome = audit.vulnerable.length
    ? "fail"
    : audit.checked === 0
      ? "skipped"
      : audit.notChecked.length
        ? "skipped"
        : "pass";
  return { outcome, gaps };
}

export function recordSecrets(rec: ScanRecorder, secrets: SecretMatch[]): CheckOutcome {
  for (const s of secrets) {
    const key = rec.addEvidence("secret_match", `${s.file}:${s.line}`, {
      type: s.type,
      file: s.file,
      line: s.line,
      preview: s.preview,
    });
    rec.addFinding(
      "SECRET_EXPOSED",
      key,
      `${s.file}:${s.line}`,
      `A secret matching the ${s.type} pattern is committed in ${s.file}:${s.line} (value redacted).`,
      s.type,
    );
  }
  rec.addEvidence("secret_match", ".", {
    kind: "summary",
    tool: "gitleaks 8.30.1",
    matches: secrets.length,
  });
  return secrets.length ? "fail" : "pass";
}

export function recordHistory(
  rec: ScanRecorder,
  map: MapResult,
  h: HistoryStats,
): { path: string }[] {
  rec.addEvidence("commit_stats", ".", {
    commits: h.commits,
    contributors: h.contributors,
    directories: h.directories
      .slice(0, 30)
      .map((d) => ({ dir: d.dir, commits: d.commits, last_touched: d.lastTouched })),
    co_changes: h.coChanges.slice(0, 30).map((c) => ({ a: c.a, b: c.b, count: c.count })),
  });
  const spots = hotspots(h.churn, fanIn(map.graph));
  for (const s of spots) {
    const key = rec.addEvidence("hotspot", s.path, {
      file: s.path,
      churn: s.churn,
      fan_in: s.fanIn,
    });
    rec.addFinding(
      "HOTSPOT",
      key,
      s.path,
      `${s.path} changes often (${s.churn} commits) and ${s.fanIn} files import it.`,
    );
  }
  return spots;
}
