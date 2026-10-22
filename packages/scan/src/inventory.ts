import type { FeatureProposal, FeatureStatus, JsonObject } from "@codesentra/core";

export interface EvidenceView {
  id: string;
  kind: string;
  locator: string;
  payload: JsonObject;
}

export interface ClassifiedFeature {
  name: string;
  status: FeatureStatus;
  /** Why this status, in words a reader can check against the evidence. */
  reason: string;
  intentIds: string[];
  implementationIds: string[];
  testIds: string[];
  /** Every id the status rests on. */
  evidenceIds: string[];
}

export interface ClassifierContext {
  evidence: Map<string, EvidenceView>;
  /** Files with TODO/FIXME/HACK/XXX markers or stubs, with the marker evidence ids. */
  markedFiles: Map<string, string[]>;
  /** Repo files each test file reaches through imports (transitively). */
  reaches(testFile: string): Set<string>;
}

const INTENT_KINDS = new Set(["doc_excerpt", "manifest"]);
const IMPLEMENTATION_KINDS = new Set(["route", "code_fact"]);
const TEST_KINDS = new Set(["test_result"]);

const fileOf = (e: EvidenceView): string | null => {
  const f = e.payload.file;
  if (typeof f === "string") return f;
  const m = /^([^#:]+)/.exec(e.locator);
  return m && m[1] !== "." ? (m[1] as string) : null;
};

/**
 * Sets each proposed feature's status from evidence alone (Section 8.5):
 * - planned: intent evidence only;
 * - partial: implementation with TODO/FIXME/stub markers in its files, a covering test that
 *   fails or is skipped, or no covering test and no route/page/handler;
 * - complete: implementation with a passing covering test, or a route/page/handler whose
 *   files carry no markers.
 * Ids that are not this run's evidence, or are the wrong kind for their slot, are ignored;
 * a feature left with no valid evidence is dropped. A test counts as covering only if its
 * file actually reaches an implementation file through imports.
 */
export function classifyFeatures(
  proposal: FeatureProposal,
  ctx: ClassifierContext,
): { features: ClassifiedFeature[]; dropped: { name: string; reason: string }[] } {
  const features: ClassifiedFeature[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const seenNames = new Set<string>();
  for (const p of proposal.features) {
    const name = p.name.trim();
    const norm = name.toLowerCase();
    if (!name || seenNames.has(norm)) {
      dropped.push({ name, reason: "duplicate or empty name" });
      continue;
    }
    const valid = (ids: string[], kinds: Set<string>) =>
      [...new Set(ids)].filter((id) => {
        const e = ctx.evidence.get(id);
        return !!e && kinds.has(e.kind);
      });
    const intentIds = valid(p.intent_evidence_ids, INTENT_KINDS);
    const proposedImpl = [...p.implementation_evidence_ids, ...p.intent_evidence_ids];
    const implementationIds = valid(proposedImpl, IMPLEMENTATION_KINDS).filter((id) => {
      const e = ctx.evidence.get(id) as EvidenceView;
      // A file-level fact for a test file is not implementation.
      return !(e.kind === "code_fact" && e.payload.test_file === true);
    });
    const implFiles = new Set(
      implementationIds
        .map((id) => fileOf(ctx.evidence.get(id) as EvidenceView))
        .filter((f): f is string => !!f),
    );
    const testIds = valid(proposedImpl, TEST_KINDS).filter((id) => {
      const t = ctx.evidence.get(id) as EvidenceView;
      const file = fileOf(t);
      if (!file) return false;
      const reach = ctx.reaches(file);
      return [...implFiles].some((f) => reach.has(f));
    });
    if (!intentIds.length && !implementationIds.length) {
      dropped.push({ name, reason: "no valid evidence" });
      continue;
    }
    seenNames.add(norm);
    const base = { name, intentIds, implementationIds, testIds };
    if (!implementationIds.length) {
      features.push({
        ...base,
        status: "planned",
        reason: "described in the docs; no implementation found",
        evidenceIds: intentIds,
      });
      continue;
    }
    const markerIds = [...implFiles].flatMap((f) => ctx.markedFiles.get(f) ?? []);
    const tests = testIds.map((id) => ctx.evidence.get(id) as EvidenceView);
    const failing = tests.filter((t) => t.payload.status === "fail");
    const skipped = tests.filter(
      (t) => t.payload.status === "skipped" || t.payload.skipped === true,
    );
    const passing = tests.filter((t) => t.payload.status === "pass");
    const all = [...intentIds, ...implementationIds, ...testIds];
    if (markerIds.length) {
      const files = [...implFiles].filter((f) => ctx.markedFiles.has(f));
      features.push({
        ...base,
        status: "partial",
        reason: `TODO/FIXME or stub markers in ${files.join(", ")}`,
        evidenceIds: [...all, ...markerIds],
      });
    } else if (failing.length || skipped.length) {
      const what = [
        failing.length ? `${failing.length} covering test failing` : "",
        skipped.length ? `${skipped.length} covering test skipped` : "",
      ]
        .filter(Boolean)
        .join(", ");
      features.push({ ...base, status: "partial", reason: what, evidenceIds: all });
    } else if (passing.length) {
      features.push({
        ...base,
        status: "complete",
        reason: `implemented and covered by ${passing.length} passing test${passing.length > 1 ? "s" : ""}`,
        evidenceIds: all,
      });
    } else if (implementationIds.some((id) => ctx.evidence.get(id)?.kind === "route")) {
      features.push({
        ...base,
        status: "complete",
        reason: "a route/page/handler with no TODO or stub markers in its files",
        evidenceIds: all,
      });
    } else {
      features.push({
        ...base,
        status: "partial",
        reason: "implemented but no test covers it",
        evidenceIds: all,
      });
    }
  }
  return { features, dropped };
}
