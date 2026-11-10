import { describe, expect, it } from "vitest";
import {
  type CheckName,
  type CheckOutcome,
  type CheckSubject,
  checkSubject,
  isCheckStatement,
  type VerifierContext,
  type VerifierEvidence,
  verifyClaim,
} from "./index.js";

/**
 * Property-based fuzz for the subject gate (WS-B, re-audit N-2). N-2's point: a false corpus of
 * hand-authored strings can only catch the paraphrases its author already thought of — a
 * same-author blind spot that passed green while a real paraphrase leak (N-1) was open. The cure
 * is not more strings; it is a property that holds over GENERATED sentences.
 *
 * WS-A moved the honesty guarantee from "recognise the success wording" (an open class) to
 * "recognise the check subject" (a closed, enumerable class). So the property we fuzz is:
 *
 *   for every check subject × every outcome FRAME (positive, negative, neutral, counted, and
 *   deliberately awkward paraphrases), the sentence is dropped from narrative as `check_statement`.
 *
 * The frames are the unbounded, adversarial part (how success/failure is worded); the subjects
 * are the closed part. Fuzzing frames × subjects proves the gate is frame-independent — the exact
 * guarantee a static corpus cannot prove. New subject phrasings found in future audits are added
 * to SUBJECT_PHRASES; a regression (a subject the classifier stops recognising) fails here, in the
 * project's own suite, not only in an external re-audit.
 */

const RUN = "00000000-0000-4000-8000-000000000001";
const manifest: VerifierEvidence = {
  id: "10000000-0000-4000-8000-000000000001",
  runId: RUN,
  kind: "manifest",
  locator: "package.json",
  payload: { name: "app", dependencies: {}, frameworks: [] },
};
const CHECKS: CheckName[] = [
  "install",
  "build",
  "typecheck",
  "lint",
  "tests",
  "dependency_audit",
  "secrets",
];
const ctx = (o: CheckOutcome): VerifierContext => ({
  runIds: new Set([RUN]),
  evidence: new Map([[manifest.id, manifest]]),
  features: [],
  checks: Object.fromEntries(CHECKS.map((c) => [c, o])) as Record<CheckName, CheckOutcome>,
});

// Subject noun phrases a real report sentence would use for each check. These are the CLOSED set
// the subject gate recognises; the frames below are the open set it must be robust to.
const SUBJECT_PHRASES: Record<CheckSubject, string[]> = {
  tests: [
    "the tests",
    "the test suite",
    "the unit tests",
    "the specs",
    "test coverage",
    "CI",
    "the pipeline",
    "every gate",
    "the checks",
  ],
  build: ["the build", "compilation", "the compiler", "the bundle", "the project build"],
  typecheck: ["the type check", "typechecking", "tsc", "the type system", "type safety"],
  lint: ["the linter", "linting", "Biome", "ESLint", "static analysis"],
  install: ["the install", "installation", "dependency install", "package resolution"],
  dependency_audit: [
    "the dependency audit",
    "the security audit",
    "the audit",
    "the CVE scan",
    "vulnerability scanning",
  ],
  secrets: [
    "the secret scan",
    "secret scanning",
    "gitleaks",
    "credential scanning",
    "the secrets check",
  ],
  health: ["the health score", "overall readiness", "the readiness score"],
};

// Outcome frames: how a sentence can assert a result about its subject. Deliberately spans the
// paraphrases the re-audit used to defeat the old phrase-list detector (spotless, without a
// hitch, sail through, nothing to report, …), positive and negative and counted alike — the gate
// must drop them ALL because the subject, not the polarity, decides.
const FRAMES: ((s: string) => string)[] = [
  (s) => `${cap(s)} passes.`,
  (s) => `${cap(s)} passed.`,
  (s) => `${cap(s)} is green.`,
  (s) => `${cap(s)} is clean.`,
  (s) => `${cap(s)} comes back spotless.`,
  (s) => `${cap(s)} succeeds without a hitch.`,
  (s) => `${cap(s)} sails through.`,
  (s) => `${cap(s)} reports no problems.`,
  (s) => `${cap(s)} turns up nothing concerning.`,
  (s) => `${cap(s)} has nothing to report.`,
  (s) => `There are no issues with ${s}.`,
  (s) => `Nothing is wrong with ${s}.`,
  (s) => `${cap(s)} fails.`,
  (s) => `${cap(s)} is broken.`,
  (s) => `${cap(s)} reports 2 of 4 passing and 1 failing.`,
  (s) => `${cap(s)} shows three failures.`,
  (s) => `We ran ${s} and it looks fine.`,
];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function* generate(): Generator<{ subject: CheckSubject; text: string }> {
  for (const subject of Object.keys(SUBJECT_PHRASES) as CheckSubject[])
    for (const phrase of SUBJECT_PHRASES[subject])
      for (const frame of FRAMES) yield { subject, text: frame(phrase) };
}

describe("subject-gate fuzz: generated check sentences are always dropped (WS-B, N-2)", () => {
  const all = [...generate()];

  it(`exercises a large generated set (${9 * 17}+ sentences across all checks)`, () => {
    expect(all.length).toBeGreaterThan(300);
  });

  it("classifies every generated sentence as a check statement", () => {
    const missed = all.filter((c) => !isCheckStatement(c.text)).map((c) => c.text);
    expect(missed).toEqual([]);
  });

  it("drops every generated sentence as check_statement, whatever the check outcome", () => {
    for (const outcome of ["pass", "fail", "skipped"] as CheckOutcome[]) {
      const kept = all.filter(
        (c) => verifyClaim({ text: c.text, evidence_ids: [manifest.id] }, ctx(outcome)).verified,
      );
      expect(
        kept.map((c) => c.text),
        `outcome=${outcome}`,
      ).toEqual([]);
    }
  });

  it("does not over-reach: plain project narrative is not misread as a check subject", () => {
    // False positives would silently drop legitimate narrative. These sentences describe the
    // project, its features, routes and env vars — no check subject — so they must pass the gate.
    const narrative = [
      "The service is a small HTTP API for task lists.",
      "It is built with Express.",
      "Users create tasks with POST /tasks.",
      "TASKBOARD_ADMIN_TOKEN is read in src/server.ts.",
      "CSV export is partial: exportCsv in src/lib/csv.ts throws.",
      "Email reminders are planned on the roadmap.",
      "The project stores tasks in memory.",
      "Tasks can be assigned to a user.",
    ];
    const flagged = narrative.filter((t) => checkSubject(t) !== null);
    expect(flagged).toEqual([]);
  });
});
