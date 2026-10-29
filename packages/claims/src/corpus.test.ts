import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CheckName,
  type CheckOutcome,
  type VerifierContext,
  type VerifierEvidence,
  verifyClaim,
} from "./index.js";

/**
 * Adversarial corpus for the claim verifier (WS-2, audit F-02). The false set — every wording
 * of "the checks passed" when they did not, quality boasts, fabricated technologies and
 * numbers — must be dropped in full. The true set — the same outcome language when the checks
 * did pass, plus plain facts the evidence supports — must survive almost entirely.
 */
const DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../test-fixtures");
const corpus = JSON.parse(readFileSync(join(DIR, "corpus.json"), "utf8")) as {
  false: { text: string; cite: string }[];
  true: { text: string; cite: string }[];
};

const RUN = "00000000-0000-4000-8000-000000000001";
const manifest: VerifierEvidence = {
  id: "10000000-0000-4000-8000-000000000001",
  runId: RUN,
  kind: "manifest",
  locator: "package.json",
  payload: {
    name: "ts-taskboard",
    dependencies: { express: "4.22.3", lodash: "4.17.15" },
    frameworks: ["Express"],
  },
};
const route: VerifierEvidence = {
  id: "10000000-0000-4000-8000-000000000002",
  runId: RUN,
  kind: "route",
  locator: "src/health.ts:3",
  payload: { method: "GET", path: "/health", file: "src/health.ts", line: 3 },
};
const evidence = new Map([manifest, route].map((e) => [e.id, e]));
const CHECKS: CheckName[] = [
  "install",
  "build",
  "typecheck",
  "lint",
  "tests",
  "dependency_audit",
  "secrets",
];
const allChecks = (o: CheckOutcome) => Object.fromEntries(CHECKS.map((c) => [c, o]));
const cite = (name: string) =>
  name === "none" ? [] : name === "route" ? [route.id] : [manifest.id];

const failCtx: VerifierContext = {
  runIds: new Set([RUN]),
  evidence,
  features: [],
  checks: allChecks("fail"),
};
const passCtx: VerifierContext = {
  runIds: new Set([RUN]),
  evidence,
  features: [],
  checks: allChecks("pass"),
};

describe("claim verifier adversarial corpus (WS-2, F-02)", () => {
  it(`drops 100% of the false corpus (${corpus.false.length} claims)`, () => {
    expect(corpus.false.length).toBeGreaterThanOrEqual(200);
    const kept = corpus.false.filter(
      (c) => verifyClaim({ text: c.text, evidence_ids: cite(c.cite) }, failCtx).verified,
    );
    expect(kept.map((c) => c.text)).toEqual([]);
  });

  it(`keeps at least 95% of the true corpus (${corpus.true.length} claims)`, () => {
    expect(corpus.true.length).toBeGreaterThanOrEqual(100);
    const dropped = corpus.true.filter(
      (c) => !verifyClaim({ text: c.text, evidence_ids: cite(c.cite) }, passCtx).verified,
    );
    // Report false drops so the lexicon can be tuned.
    if (dropped.length)
      console.log(
        "true claims dropped:",
        JSON.stringify(
          dropped.map((c) => c.text),
          null,
          1,
        ),
      );
    expect(dropped.length / corpus.true.length).toBeLessThanOrEqual(0.05);
  });

  it("is deterministic: the same claim verifies the same way twice", () => {
    for (const c of [...corpus.false.slice(0, 20), ...corpus.true.slice(0, 20)]) {
      const a = verifyClaim({ text: c.text, evidence_ids: cite(c.cite) }, failCtx);
      const b = verifyClaim({ text: c.text, evidence_ids: cite(c.cite) }, failCtx);
      expect(a).toEqual(b);
    }
  });
});
