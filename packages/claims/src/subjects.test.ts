import { describe, expect, it } from "vitest";
import { checkSubject, isCheckStatement } from "./subjects.js";

// Development set (WS-A): written to exercise the subject gate, kept separate from any held-out
// evaluation set. A sentence about a check — in ANY phrasing — must be recognised as a check
// subject so it is dropped from narrative; a sentence about the project, a feature, a route or
// an env var must NOT be, so it survives verification on its own merits.

const CHECK_SENTENCES: [string, string][] = [
  // tests / suite / coverage / CI — varied phrasing, success, failure, neutral
  ["The full suite runs without a single failure.", "tests"],
  ["Two tests are currently failing.", "tests"],
  ["The project has 412 passing tests.", "tests"],
  ["Coverage sits at 83%.", "tests"],
  ["The code is thoroughly covered by tests.", "tests"],
  ["Tests sail through.", "tests"],
  ["Every spec is in the green.", "tests"],
  ["CI is red on main.", "tests"],
  ["The pipeline passes end to end.", "tests"],
  ["The checks are all in order.", "tests"],
  ["It passes every gate.", "tests"],
  ["The test run is spotless.", "tests"],
  ["There are zero broken specs.", "tests"],
  // build
  ["The build compiles without a hitch.", "build"],
  ["Compilation failed on the worker package.", "build"],
  ["The project builds end to end.", "build"],
  ["The bundle is produced cleanly.", "build"],
  ["The build finishes with no warnings.", "build"],
  ["The compiler emits no diagnostics.", "typecheck"],
  // typecheck
  ["tsc has nothing to say.", "typecheck"],
  ["There are no type errors.", "typecheck"],
  ["The code is type-safe.", "typecheck"],
  ["Type safety holds throughout.", "typecheck"],
  ["Typechecking reported three errors.", "typecheck"],
  ["The compiler is satisfied.", "typecheck"],
  // lint
  ["Linting comes back spotless.", "lint"],
  ["ESLint flags nothing.", "lint"],
  ["Biome reports no problems.", "lint"],
  ["The linter has no notes.", "lint"],
  ["The formatter left everything as-is.", "lint"],
  // install
  ["Dependencies install with no errors.", "install"],
  ["Packages pull down without complaint.", "install"],
  ["Installation failed resolving a peer dependency.", "install"],
  // dependency audit
  ["The dependency audit is clean.", "dependency_audit"],
  ["There are no known vulnerabilities.", "dependency_audit"],
  ["Three CVEs were found in the tree.", "dependency_audit"],
  ["The audit turns up nothing concerning.", "dependency_audit"],
  ["Dependencies are secure.", "dependency_audit"],
  // secrets
  ["No secrets were detected in the codebase.", "secrets"],
  ["The repo is free of hard-coded credentials.", "secrets"],
  ["Security scanning found nothing.", "secrets"],
  ["No API keys are committed.", "secrets"],
  ["Gitleaks reported one match.", "secrets"],
  // health / readiness (templated from the score, never narrated)
  ["The health score is 78.", "health"],
  ["The project is production-ready.", "health"],
  ["Overall readiness is high.", "health"],
];

const NON_CHECK_SENTENCES = [
  "CodeSentra scans a repository and reports what is complete.",
  "It exposes a GET /health route.",
  "The service is built with Fastify.",
  "The CLI reads NEXT_PUBLIC_API_URL from the environment.",
  "Users upload a zip and receive an evidence-linked report.",
  "The health endpoint lives in src/health.ts.",
  "The application is named ts-taskboard.",
  "It depends on Express for routing.",
  "The worker processes jobs from a Postgres-backed queue.",
  "A presigned POST uploads the archive straight to storage.",
  "The dashboard shows each issue with a fix prompt.",
  "The report cites evidence for every claim.",
  "Pulse checks a deployed URL for reachability and TLS.",
  "The project targets Node 22.",
];

describe("check-subject recognition (WS-A, N-4)", () => {
  it("recognises a check subject in any phrasing", () => {
    const missed = CHECK_SENTENCES.filter(([t]) => !isCheckStatement(t));
    expect(missed.map(([t]) => t)).toEqual([]);
  });

  it("maps each sentence to the right check", () => {
    const wrong = CHECK_SENTENCES.filter(([t, want]) => checkSubject(t) !== want).map(
      ([t, want]) => `${t} -> ${checkSubject(t)} (want ${want})`,
    );
    expect(wrong).toEqual([]);
  });

  it("does not flag sentences about the project, a feature, a route or an env var", () => {
    const falsePositives = NON_CHECK_SENTENCES.filter((t) => isCheckStatement(t));
    expect(falsePositives).toEqual([]);
  });

  it("is a pure function of its input", () => {
    expect(checkSubject("Tests sail through.")).toBe(checkSubject("Tests sail through."));
  });
});
