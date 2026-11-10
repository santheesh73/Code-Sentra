import type { CheckName, CheckOutcome } from "./index.js";

/**
 * Deterministic, templated check lines (WS-A, re-audit N-4). Check results are rendered here
 * from stored run data — never written by the model — so the report states them in fixed,
 * versioned language the narrative cannot spin. Paired with the verifier's subject gate
 * (subjects.ts), which drops any model sentence about a check, this makes the honesty guarantee
 * structural: the only place a check outcome can appear is a line produced by this function.
 *
 * Every state is covered: pass, fail (with counts), partial (some passed, some failed), skipped
 * and gap (skipped with a reason). Same input → identical output.
 */

export const CHECK_LINES_VERSION = 1;

export interface CheckResult {
  name: CheckName;
  outcome: CheckOutcome;
  /** Parsed counts where the check produces them (tests, lint). */
  counts?: { passed?: number; failed?: number; skipped?: number };
  /** Why a skipped check did not run (a gap reason), or a short factual detail. */
  detail?: string;
}

const LABEL: Record<CheckName, string> = {
  install: "Install",
  build: "Build",
  typecheck: "Typecheck",
  lint: "Lint",
  tests: "Tests",
  dependency_audit: "Dependency audit",
  secrets: "Secrets scan",
};

function countsPhrase(c: NonNullable<CheckResult["counts"]>): string {
  const parts: string[] = [];
  if (c.passed !== undefined) parts.push(`${c.passed} passed`);
  if (c.failed !== undefined) parts.push(`${c.failed} failed`);
  if (c.skipped !== undefined) parts.push(`${c.skipped} skipped`);
  return parts.join(", ");
}

/** One deterministic line for a check, from its stored result. */
export function renderCheckLine(r: CheckResult): string {
  const label = LABEL[r.name];
  const counts = r.counts ? countsPhrase(r.counts) : "";
  switch (r.outcome) {
    case "pass":
      return `${label}: passed${counts ? ` — ${counts}` : ""}`;
    case "fail":
      return `${label}: failed${counts ? ` — ${counts}` : ""}`;
    case "skipped":
      return `${label}: not run${r.detail ? ` — ${r.detail}` : ""} (gap)`;
    case "not_applicable":
      return `${label}: not applicable${r.detail ? ` — ${r.detail}` : ""}`;
  }
}

/** The templated lines for a set of checks, in a stable order. */
export function renderCheckLines(results: CheckResult[]): string[] {
  const order: CheckName[] = [
    "install",
    "build",
    "typecheck",
    "lint",
    "tests",
    "dependency_audit",
    "secrets",
  ];
  return [...results]
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
    .map(renderCheckLine);
}
