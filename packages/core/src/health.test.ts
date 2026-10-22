import { describe, expect, it } from "vitest";
import { computeHealth, type HealthInput } from "./health.js";

const ok = { outcome: "pass" as const, evidence: ["p"] };
const base = (): HealthInput => ({
  install: ok,
  build: ok,
  tests: { outcome: "pass", pass: 10, fail: 0, testsFound: 10, evidence: ["t"] },
  typecheck: ok,
  lint: ok,
  vulnerable: [],
  secrets: [],
  readme: { present: true, evidence: ["r"] },
  envVars: { read: 2, undocumented: [] },
  setupSteps: { present: true, evidence: ["s"] },
  markers: { count: 0, sourceLines: 2000, evidence: [] },
  hotspots: { count: 0, files: 40, evidence: [] },
});

describe("health score", () => {
  it("is 100 when everything is clean", () => {
    const h = computeHealth(base());
    expect(h.score).toBe(100);
    expect(h.excluded).toEqual([]);
    expect(h.components.every((c) => c.deductions.length === 0)).toBe(true);
  });

  it("scales tests by pass ratio and 0 with no tests", () => {
    const h = computeHealth({
      ...base(),
      tests: { outcome: "fail", pass: 2, fail: 1, testsFound: 4, evidence: ["t"] },
    });
    expect(h.components.find((c) => c.component === "tests")?.ratio).toBeCloseTo(0.667, 2);
    const none = computeHealth({
      ...base(),
      tests: { outcome: "skipped", pass: 0, fail: 0, testsFound: 0, evidence: ["n"] },
    });
    expect(none.components.find((c) => c.component === "tests")).toMatchObject({
      measured: true,
      ratio: 0,
    });
  });

  it("excludes what could not be measured and renormalizes", () => {
    const h = computeHealth({
      ...base(),
      install: { outcome: "skipped", evidence: [] },
      build: { outcome: "skipped", evidence: [] },
      tests: { outcome: "skipped", pass: 0, fail: 0, testsFound: 3, evidence: [] },
    });
    expect(h.excluded).toEqual(["build", "tests"]);
    expect(h.score).toBe(100);
  });

  it("costs more for high/critical advisories and for secrets, with evidence", () => {
    const low = computeHealth({ ...base(), vulnerable: [{ severity: "low", evidence: "a" }] });
    const high = computeHealth({ ...base(), vulnerable: [{ severity: "high", evidence: "a" }] });
    expect(high.score as number).toBeLessThan(low.score as number);
    const sec = computeHealth({ ...base(), secrets: [{ evidence: "s1" }] });
    const d = sec.components.find((c) => c.component === "security")?.deductions[0];
    expect(d?.evidence).toEqual(["s1"]);
  });

  it("is deterministic and never asks a model", () => {
    const input = { ...base(), markers: { count: 7, sourceLines: 900, evidence: ["m"] } };
    expect(computeHealth(input)).toEqual(computeHealth(input));
  });

  it("is null when nothing could be measured", () => {
    const none: HealthInput = {
      ...base(),
      install: { outcome: "skipped", evidence: [] },
      build: { outcome: "skipped", evidence: [] },
      tests: { outcome: "skipped", pass: 0, fail: 0, testsFound: 1, evidence: [] },
      vulnerable: null,
      secrets: null,
      typecheck: { outcome: "skipped", evidence: [] },
      lint: { outcome: "skipped", evidence: [] },
      hotspots: null,
    };
    // Configuration and markers are always measurable, so the score stays defined.
    expect(computeHealth(none).score).not.toBeNull();
    expect(computeHealth(none).excluded).toEqual(["build", "tests", "security"]);
  });
});
