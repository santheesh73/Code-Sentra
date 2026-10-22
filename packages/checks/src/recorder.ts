import {
  type EvidenceKind,
  FINDING_CODE_DECLARATIONS,
  type FindingCode,
  type JsonObject,
  normalizeMessage,
} from "@codesentra/core";
import type { EvidenceDraft, FindingDraft } from "./types.js";

/** Collects evidence and findings; deduplicates findings on (code, locator, discriminator). */
export class Recorder {
  readonly evidence: EvidenceDraft[] = [];
  readonly findings: FindingDraft[] = [];
  screenshot: Buffer | null = null;
  private seq = 0;
  private readonly seen = new Set<string>();

  addEvidence(kind: EvidenceKind, locator: string, payload: JsonObject): string {
    const key = `ev${++this.seq}`;
    this.evidence.push({ key, kind, locator, payload });
    return key;
  }

  addFinding(
    code: FindingCode,
    evidenceKey: string,
    locator: string,
    message: string,
    discriminator?: string,
  ): void {
    const dedupe = `${code}\n${locator}\n${discriminator ? normalizeMessage(discriminator) : ""}`;
    if (this.seen.has(dedupe)) return;
    this.seen.add(dedupe);
    this.findings.push({
      code,
      severity: FINDING_CODE_DECLARATIONS[code].defaultSeverity,
      evidenceKey,
      locator,
      ...(discriminator !== undefined ? { discriminator: normalizeMessage(discriminator) } : {}),
      message,
    });
  }
}
