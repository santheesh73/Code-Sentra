import {
  type EvidenceKind,
  FINDING_CODE_DECLARATIONS,
  type FindingCode,
  type JsonObject,
  normalizeMessage,
  type Severity,
} from "@codesentra/core";

export interface EvidenceDraft {
  key: string;
  kind: EvidenceKind;
  locator: string;
  payload: JsonObject;
}

export interface FindingDraft {
  code: FindingCode;
  severity: Severity;
  evidenceKey: string;
  /** Repo-relative `path[:line]`; the fingerprint keeps path + symbol for Scan. */
  locator: string;
  discriminator?: string;
  message: string;
}

/** Collects one Scan run's evidence and findings; findings dedupe on (code, locator, discriminator). */
export class ScanRecorder {
  readonly evidence: EvidenceDraft[] = [];
  readonly findings: FindingDraft[] = [];
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
    severity?: Severity,
  ): void {
    const dedupe = `${code}\n${locator}\n${discriminator ? normalizeMessage(discriminator) : ""}`;
    if (this.seen.has(dedupe)) return;
    this.seen.add(dedupe);
    this.findings.push({
      code,
      severity: severity ?? FINDING_CODE_DECLARATIONS[code].defaultSeverity,
      evidenceKey,
      locator,
      ...(discriminator !== undefined ? { discriminator: normalizeMessage(discriminator) } : {}),
      message,
    });
  }

  byKey(key: string): EvidenceDraft | undefined {
    return this.evidence.find((e) => e.key === key);
  }
}
