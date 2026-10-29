import { describe, expect, it } from "vitest";
import { loadFixtureRepos, readLocator } from "./repos.js";

const repos = loadFixtureRepos();

describe("fixture repos", () => {
  it("include a repo for every parsed language", () => {
    const langs = repos.flatMap((r) => r.expected.languages);
    for (const l of ["TypeScript", "Python", "Go", "Ruby", "Java"]) expect(langs).toContain(l);
  });

  for (const { expected, repoDir } of repos) {
    describe(expected.name, () => {
      it("plants every finding category required by Section 13", () => {
        const codes = new Set(expected.findings.map((f) => f.code));
        for (const code of [
          // A failing test can only be observed where tests run in the sandbox.
          ...(expected.probes.tests ? ["TESTS_FAILING"] : []),
          "TODO_MARKER",
          "ENV_VAR_UNDOCUMENTED",
          "SECRET_EXPOSED",
          "VULNERABLE_DEPENDENCY",
        ]) {
          expect(codes.has(code), code).toBe(true);
        }
        for (const absent of expected.absentFindings) expect(codes.has(absent), absent).toBe(false);
      });

      it("finding locators point at the stated text", () => {
        for (const f of expected.findings) {
          const text = readLocator(repoDir, f.locator);
          expect(text, `${f.code} ${f.locator}`).not.toBeNull();
          if (f.lineContains) expect(text, `${f.code} ${f.locator}`).toContain(f.lineContains);
        }
      });

      it("route locators point at the route registration", () => {
        for (const r of expected.routes) {
          expect(readLocator(repoDir, r.locator), r.locator).toContain(`"${r.path}"`);
        }
      });

      it("env var locators read the named variable", () => {
        for (const v of expected.envVars.read) {
          expect(readLocator(repoDir, v.locator), v.locator).toContain(v.name);
        }
        const envExample = readLocator(repoDir, ".env.example") ?? "";
        for (const name of expected.envVars.documented) {
          expect(envExample, name).toMatch(new RegExp(`^${name}=`, "m"));
        }
        const undocumented = expected.findings
          .filter((f) => f.code === "ENV_VAR_UNDOCUMENTED")
          .map((f) => f.envVar as string);
        for (const name of undocumented) {
          expect(envExample).not.toMatch(new RegExp(`^${name}=`, "m"));
        }
      });

      it("feature evidence resolves, and statuses follow the evidence shape", () => {
        for (const feat of expected.features) {
          for (const loc of [
            ...(feat.implementation ?? []),
            ...(feat.tests ?? []),
            ...(feat.intent ?? []),
          ]) {
            expect(readLocator(repoDir, loc), `${feat.name} ${loc}`).not.toBeNull();
          }
          if (feat.status === "planned") {
            expect(feat.implementation ?? [], feat.name).toEqual([]);
            for (const loc of feat.intent ?? []) {
              expect(readLocator(repoDir, loc), loc).toContain(feat.name);
            }
          } else {
            expect((feat.implementation ?? []).length, feat.name).toBeGreaterThan(0);
          }
          if (feat.status === "partial") expect(feat.why, feat.name).toBeTruthy();
        }
        const readme = readLocator(repoDir, "README.md") ?? "";
        for (const feat of expected.features) expect(readme, feat.name).toContain(feat.name);
      });

      it("probe expectations are internally consistent", () => {
        const failing = expected.findings.filter((f) => f.code === "TESTS_FAILING").length;
        const skipped = expected.findings.filter((f) => f.code === "SKIPPED_TESTS").length;
        if (expected.probes.tests) {
          expect(expected.probes.tests.fail).toBe(failing);
          expect(expected.probes.tests.skip).toBe(skipped);
        } else {
          // Not run: no failing test can be claimed; skips are read from the source.
          expect(failing).toBe(0);
        }
      });
    });
  }
});
