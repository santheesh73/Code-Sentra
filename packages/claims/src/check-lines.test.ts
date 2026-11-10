import { describe, expect, it } from "vitest";
import {
  CHECK_LINES_VERSION,
  type CheckResult,
  renderCheckLine,
  renderCheckLines,
} from "./check-lines.js";
import type { CheckName } from "./index.js";

/**
 * Check lines are the ONLY place a check outcome may appear in a report (WS-A). They are rendered
 * from stored run data by fixed templates, so the language is versioned and the narrative cannot
 * spin it. These tests pin every check × every state and prove determinism: same input → identical
 * output, byte for byte.
 */

const CHECKS: CheckName[] = [
  "install",
  "build",
  "typecheck",
  "lint",
  "tests",
  "dependency_audit",
  "secrets",
];

describe("renderCheckLine: every check × every state", () => {
  it("renders a passed check, with and without counts", () => {
    expect(renderCheckLine({ name: "build", outcome: "pass" })).toBe("Build: passed");
    expect(
      renderCheckLine({ name: "tests", outcome: "pass", counts: { passed: 12, failed: 0 } }),
    ).toBe("Tests: passed — 12 passed, 0 failed");
  });

  it("renders a failed check with counts", () => {
    expect(
      renderCheckLine({
        name: "tests",
        outcome: "fail",
        counts: { passed: 2, failed: 1, skipped: 1 },
      }),
    ).toBe("Tests: failed — 2 passed, 1 failed, 1 skipped");
  });

  it("renders a partial result (some passed, some failed) from counts", () => {
    // "Partial" is not a distinct outcome: it is a fail/pass with a mixed count, stated factually.
    expect(
      renderCheckLine({ name: "tests", outcome: "fail", counts: { passed: 3, failed: 2 } }),
    ).toBe("Tests: failed — 3 passed, 2 failed");
  });

  it("renders a skipped check as a gap, with and without a reason", () => {
    expect(renderCheckLine({ name: "lint", outcome: "skipped" })).toBe("Lint: not run (gap)");
    expect(
      renderCheckLine({ name: "lint", outcome: "skipped", detail: "no lint script configured" }),
    ).toBe("Lint: not run — no lint script configured (gap)");
  });

  it("renders a not-applicable check, with and without a reason", () => {
    expect(renderCheckLine({ name: "dependency_audit", outcome: "not_applicable" })).toBe(
      "Dependency audit: not applicable",
    );
    expect(
      renderCheckLine({
        name: "dependency_audit",
        outcome: "not_applicable",
        detail: "no lockfile",
      }),
    ).toBe("Dependency audit: not applicable — no lockfile");
  });

  it("uses the correct human label for every check name", () => {
    const labels = CHECKS.map((name) => renderCheckLine({ name, outcome: "pass" }));
    expect(labels).toEqual([
      "Install: passed",
      "Build: passed",
      "Typecheck: passed",
      "Lint: passed",
      "Tests: passed",
      "Dependency audit: passed",
      "Secrets scan: passed",
    ]);
  });

  it("covers every outcome for every check without throwing", () => {
    const outcomes = ["pass", "fail", "skipped", "not_applicable"] as const;
    for (const name of CHECKS) {
      for (const outcome of outcomes) {
        const line = renderCheckLine({ name, outcome });
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("renderCheckLines: stable order and set rendering", () => {
  it("sorts into the fixed check order regardless of input order", () => {
    const results: CheckResult[] = [
      { name: "secrets", outcome: "pass" },
      { name: "install", outcome: "pass" },
      { name: "tests", outcome: "fail", counts: { passed: 2, failed: 1 } },
      { name: "build", outcome: "pass" },
    ];
    expect(renderCheckLines(results)).toEqual([
      "Install: passed",
      "Build: passed",
      "Tests: failed — 2 passed, 1 failed",
      "Secrets scan: passed",
    ]);
  });
});

describe("determinism (WS-A acceptance)", () => {
  it("produces byte-identical output for the same input, twice", () => {
    const outcomes = ["pass", "fail", "skipped", "not_applicable"] as const;
    const results: CheckResult[] = CHECKS.map((name, i) => ({
      name,
      outcome: outcomes[i % outcomes.length] ?? "pass",
      counts: i === 4 ? { passed: 2, failed: 1, skipped: 1 } : undefined,
      detail: i === 3 ? "no lint script configured" : undefined,
    }));
    const a = renderCheckLines(results);
    const b = renderCheckLines([...results]);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("pins the templated-line version", () => {
    // Bump this deliberately when the templated wording changes, so reports record which template
    // version produced their check lines.
    expect(CHECK_LINES_VERSION).toBe(1);
  });
});
