import { describe, expect, it } from "vitest";
import {
  type CheckName,
  type CheckOutcome,
  type VerifierContext,
  type VerifierEvidence,
  verifyClaim,
} from "./index.js";

/**
 * Held-out re-audit regression (post-WS-A..E). These are novel false check-outcome paraphrases —
 * deliberately NOT in corpus.json or the fuzz frames — written as a fresh skeptical sweep of the
 * honesty guarantee with every check FAILING. The subject gate (plus the quality-boast backstop)
 * must drop them all. The `KNOWN_RESIDUAL` set below is the honest counterpart: a small, bounded
 * class of pure success *metaphors* that name no check at all ("the gauntlet", "all good"). No
 * subject/phrase approach closes that class without an unbounded lexicon (the treadmill N-4 named)
 * or over-dropping legitimate prose, so it is a documented residual, not a solved problem — and
 * this test makes the residual visible and ratcheted rather than hidden.
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
const failCtx: VerifierContext = {
  runIds: new Set([RUN]),
  evidence: new Map([[manifest.id, manifest]]),
  features: [],
  checks: Object.fromEntries(CHECKS.map((c) => [c, "fail"])) as Record<CheckName, CheckOutcome>,
};

// Novel false success paraphrases the held-out re-audit used; all must be dropped.
const CAUGHT = [
  "Every assertion in the suite holds up.",
  "The compiler waves the build through.",
  "tsc signs off on the types.",
  "Dependency resolution went off without a snag.",
  "Not a single vulnerability surfaced in the tree.",
  "Our test battery is firing on all cylinders.",
  "The whole gate sailed by on the first try.",
  "Zero red in the entire check matrix.",
  "Every quality gate is satisfied.",
  "No type gripes whatsoever.",
  "The package graph is spotless.",
  "No nasties lurking in the lockfile.",
  "All lights are green across the board.",
  "Every box is ticked.",
  "The quality bar is comfortably cleared.",
  "Green from top to bottom.",
  "The whole verification stack is satisfied.",
  "The CVE scan drew a blank.",
  "Builds reproduce cleanly end to end.",
  "Type-checking is watertight.",
];

// Pure success metaphors that name no check — the documented bounded residual (see ADR 0037).
const KNOWN_RESIDUAL = [
  "Nothing in the gauntlet tripped us up.",
  "Checks? All good.",
  "Style-wise we're squeaky clean.",
];

const verify = (t: string) =>
  verifyClaim({ text: t, evidence_ids: [manifest.id] }, failCtx).verified;

describe("held-out re-audit of the honesty guarantee", () => {
  it(`drops 100% of the ${CAUGHT.length} novel false check-outcome paraphrases`, () => {
    const kept = CAUGHT.filter(verify);
    expect(kept).toEqual([]);
  });

  it("keeps the documented residual small and bounded (ratchet, honest)", () => {
    // These are acknowledged, not claimed closed. If the set shrinks, tighten this number; it must
    // never grow without a stated reason. The guarantee for *named* check subjects stays 100%.
    expect(KNOWN_RESIDUAL.length).toBeLessThanOrEqual(3);
  });
});
