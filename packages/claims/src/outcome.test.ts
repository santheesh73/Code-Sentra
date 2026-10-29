import { describe, expect, it } from "vitest";
import type { CheckName, CheckOutcome } from "./index.js";
import { checkOutcomeClaims, outcomeClaims } from "./outcome.js";

const CHECKS: CheckName[] = [
  "install",
  "build",
  "typecheck",
  "lint",
  "tests",
  "dependency_audit",
  "secrets",
];
const all = (o: CheckOutcome) => Object.fromEntries(CHECKS.map((c) => [c, o]));

describe("outcome-language detector (WS-2, F-02)", () => {
  // The exact strings the audit showed slipping past the old phrase list.
  const AUDIT_BYPASSES = [
    "All tests are passing.",
    "Tests are passing.",
    "The tests are all green.",
    "Every test succeeds.",
    "The test suite is fully green.",
    "Lint passes.",
    "Linting is clean.",
    "The build is green.",
    "Compiles fine.",
    "Installs fine.",
    "CI is green.",
    "The repository contains no hard-coded credentials.",
    "It is fully tested and production-ready.",
    "It is secure against SQL injection.",
    "It never crashes.",
  ];
  it("rejects every audit bypass when the checks did not pass", () => {
    const survivors = AUDIT_BYPASSES.filter((t) => checkOutcomeClaims(t, all("fail")).ok);
    expect(survivors).toEqual([]);
  });
  it("rejects a check claim when the check was skipped, not only when it failed", () => {
    expect(
      checkOutcomeClaims("Type checking succeeds with no errors.", { typecheck: "skipped" }).ok,
    ).toBe(false);
    expect(checkOutcomeClaims("Type checking succeeds with no errors.", {}).ok).toBe(false);
  });
  it("accepts the same outcome language when the checks did pass", () => {
    for (const t of [
      "All tests pass.",
      "The build is green.",
      "Lint passes.",
      "No known vulnerabilities remain.",
    ])
      expect(checkOutcomeClaims(t, all("pass")).ok, t).toBe(true);
  });
  it("does not flag a negated or partial result as a success claim", () => {
    // Honest reporting: not blanket success, so not policed here.
    expect(checkOutcomeClaims("Not all tests pass.", all("fail")).ok).toBe(true);
    expect(checkOutcomeClaims("2 of 4 tests pass and 1 fails.", all("fail")).ok).toBe(true);
    expect(checkOutcomeClaims("The build does not pass.", all("fail")).ok).toBe(true);
  });
  it("always rejects an unfalsifiable quality boast", () => {
    for (const t of [
      "It is production-ready.",
      "It is bug-free.",
      "It never fails.",
      "The service is bulletproof.",
    ])
      expect(checkOutcomeClaims(t, all("pass")).ok, t).toBe(false);
  });
  it("is a pure function of its inputs", () => {
    expect(outcomeClaims("All tests pass and the build is green.")).toEqual(
      outcomeClaims("All tests pass and the build is green."),
    );
  });
});
