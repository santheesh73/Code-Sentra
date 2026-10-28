import {
  FINDING_CODE_DECLARATIONS,
  type FindingCode,
  groupFindings,
  type JsonObject,
  type RecheckSpec,
  recheckFor,
  type Severity,
} from "@codesentra/core";
import { fingerprint } from "@codesentra/core/hashing";
import {
  issueTitle,
  type PromptTrace,
  type RenderedPrompt,
  renderPrompt,
} from "@codesentra/prompts";
import { adapterByName } from "./platforms/index.js";
import type { PlatformIdentity } from "./types.js";

export interface FindingLike {
  code: FindingCode;
  severity: Severity;
  evidenceKey: string;
  locator: string;
  discriminator?: string | null;
  message: string;
}

export interface EvidenceLike {
  key: string;
  kind: string;
  locator: string;
  payload: JsonObject;
}

export interface DraftContext {
  target: { url: string; environment: string | null };
  project: { name: string; repoUrl: string | null } | null;
  platform: Pick<PlatformIdentity, "name" | "environment" | "reason"> | null;
  lastSuccessfulCheck: string | null;
  scanSummary: string | null;
  /**
   * Sentra Link's trace for an issue's leading finding: a verified trace makes the prompt
   * `code_fix`; `reclassifiedAs` replaces the lead code (ROUTE_BROKEN with no route is
   * ROUTE_MISSING). Absent: no trace (Pulse alone, Quick Pulse).
   */
  traceOf?: (leader: FindingLike & { index: number }) => {
    trace: PromptTrace | null;
    reclassifiedAs: FindingCode | null;
  };
}

export interface IssueDraftOut {
  fingerprint: string;
  code: FindingCode;
  severity: Severity;
  title: string;
  locator: string;
  summary: string;
  corroboratingCodes: FindingCode[];
  /** Indexes into the input findings. */
  findingIndexes: number[];
  recheck: RecheckSpec;
  prompt: RenderedPrompt;
  /** The verified trace the prompt was written from, if any. */
  trace: PromptTrace | null;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function findingFingerprint(
  f: Pick<FindingLike, "code" | "locator" | "discriminator">,
): string {
  const module = FINDING_CODE_DECLARATIONS[f.code].recheck.module;
  return fingerprint(f.code, module, f.locator, f.discriminator ?? undefined);
}

/**
 * Turns one run's findings (Pulse or Scan) into issue drafts: merge by shared evidence (Section
 * 10c), fingerprint by the leading finding, attach the stored re-check, and render the
 * prompt. Info findings never become issues. Every draft has a prompt (Rule 4).
 */
export function draftIssues(
  findings: FindingLike[],
  evidence: EvidenceLike[],
  ctx: DraftContext,
): IssueDraftOut[] {
  const indexed = findings
    .map((f, index) => ({ ...f, index }))
    .filter((f) => f.severity !== "info");
  const adapter = adapterByName(ctx.platform?.name);
  const hints = {
    env_var: adapter.configHint("env_var"),
    access_protection: adapter.configHint("access_protection"),
    production_domain: adapter.configHint("production_domain"),
    redirects: adapter.configHint("redirects"),
    headers: adapter.configHint("headers"),
  };
  const byKey = new Map(evidence.map((e) => [e.key, e]));
  return groupFindings(indexed).map(({ leader, members }) => {
    const severity = members.reduce<Severity>(
      (s, m) => (RANK[m.severity] < RANK[s] ? m.severity : s),
      leader.severity,
    );
    const ev = [...new Set(members.map((m) => m.evidenceKey))]
      .map((k) => byKey.get(k))
      .filter((e): e is EvidenceLike => Boolean(e));
    const linked = ctx.traceOf?.(leader) ?? { trace: null, reclassifiedAs: null };
    const code = linked.reclassifiedAs ?? leader.code;
    const title = issueTitle(code, leader.locator, leader.discriminator);
    const prompt = renderPrompt({
      code,
      title,
      severity,
      locator: leader.locator,
      message: leader.message,
      discriminator: leader.discriminator ?? null,
      corroborating: members.slice(1).map((m) => ({ code: m.code, message: m.message })),
      evidence: ev.map((e) => ({ kind: e.kind, locator: e.locator, payload: e.payload })),
      hasVerifiedTrace: !!linked.trace,
      trace: linked.trace,
      platform: ctx.platform,
      hints,
      target: ctx.target,
      project: ctx.project,
      lastSuccessfulCheck: ctx.lastSuccessfulCheck,
      scanSummary: ctx.scanSummary,
    });
    return {
      fingerprint: findingFingerprint({ ...leader, code }),
      code,
      severity,
      title,
      locator: leader.locator,
      summary: leader.message,
      corroboratingCodes: members.slice(1).map((m) => m.code),
      findingIndexes: members.map((m) => m.index),
      recheck: recheckFor(code, leader.locator, ctx.target.url, leader.discriminator),
      prompt,
      trace: linked.trace,
    };
  });
}
