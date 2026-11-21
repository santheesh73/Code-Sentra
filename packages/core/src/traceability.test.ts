import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Keeps docs/spec/TRACEABILITY.md honest (WS-E). Every requirement area must name the code, the
 * tests, and the CI gate(s) that run those tests; every CI gate it names must be a real job in
 * .github/workflows/ci.yml; and every CI job must be traced by at least one area — so neither a
 * requirement nor a CI gate can be dropped silently. This test runs in the `test` CI job.
 */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const CI_YML = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const TABLE = readFileSync(resolve(ROOT, "docs/spec/TRACEABILITY.md"), "utf8");

/** Job names declared under `jobs:` in the CI workflow (two-space-indented `<name>:`). */
function ciJobs(): Set<string> {
  const jobs = new Set<string>();
  let inJobs = false;
  for (const line of CI_YML.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // left column 0 → out of the jobs block
    const m = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (m?.[1]) jobs.add(m[1]);
  }
  return jobs;
}

interface Row {
  area: string;
  implemented: string;
  tests: string;
  ciGate: string;
}

/** The requirement rows (area cells begin with a Section 3.x id). */
function rows(): Row[] {
  const out: Row[] = [];
  for (const line of TABLE.split("\n")) {
    if (!/^\|\s*3\.\d+/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    // ["", area, implemented, tests, ciGate, notes, ""]
    out.push({
      area: cells[1] ?? "",
      implemented: cells[2] ?? "",
      tests: cells[3] ?? "",
      ciGate: cells[4] ?? "",
    });
  }
  return out;
}

const backticked = (s: string): string[] =>
  [...s.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1] ?? "").filter(Boolean);

describe("traceability table is honest (WS-E)", () => {
  const jobs = ciJobs();
  const table = rows();

  it("finds the CI jobs and the requirement rows", () => {
    expect(jobs.size).toBeGreaterThanOrEqual(10);
    expect(table.length).toBeGreaterThanOrEqual(15);
  });

  it("every row names code, tests and at least one CI gate", () => {
    const incomplete = table.filter(
      (r) => !r.implemented || !r.tests || backticked(r.ciGate).length === 0,
    );
    expect(incomplete.map((r) => r.area)).toEqual([]);
  });

  it("every CI gate a row names is a real job in ci.yml", () => {
    const unknown: string[] = [];
    for (const r of table)
      for (const g of backticked(r.ciGate)) if (!jobs.has(g)) unknown.push(`${r.area}: ${g}`);
    expect(unknown).toEqual([]);
  });

  it("every CI job is traced by at least one requirement row", () => {
    const traced = new Set(table.flatMap((r) => backticked(r.ciGate)));
    const untraced = [...jobs].filter((j) => !traced.has(j));
    expect(untraced).toEqual([]);
  });
});
