import type { EvidenceKind, FindingCode, JsonObject, Module, Severity } from "@codesentra/core";
import { evidenceHash } from "@codesentra/core/hashing";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { evidence, findings } from "../schema.js";

export type EvidenceRow = typeof evidence.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;

export interface EvidenceInputDraft {
  key: string;
  kind: EvidenceKind;
  locator: string;
  payload: JsonObject;
}

export interface FindingInputDraft {
  code: FindingCode;
  severity: Severity;
  evidenceKey: string;
  locator: string;
  discriminator?: string | null;
  message: string;
  fingerprint: string;
}

export interface PersistedRunData {
  /** evidence draft key → evidence id */
  evidenceIds: Map<string, string>;
  /** finding ids, in the order of the input drafts */
  findingIds: string[];
}

/** Writes a run's evidence and findings (Rule 3: one evidence table for Scan and Pulse). */
export async function persistRunData(
  tx: TenantTx,
  input: {
    orgId: string;
    runId: string;
    source: Module;
    evidence: EvidenceInputDraft[];
    findings: FindingInputDraft[];
  },
): Promise<PersistedRunData> {
  const evidenceIds = new Map<string, string>();
  if (input.evidence.length > 0) {
    const rows = await tx
      .insert(evidence)
      .values(
        input.evidence.map((e) => ({
          orgId: input.orgId,
          runId: input.runId,
          kind: e.kind,
          locator: e.locator.slice(0, 4096),
          payload: e.payload,
          hash: evidenceHash({ kind: e.kind, locator: e.locator, payload: e.payload }),
        })),
      )
      .returning({ id: evidence.id });
    input.evidence.forEach((e, i) => {
      const row = rows[i];
      if (row) evidenceIds.set(e.key, row.id);
    });
  }
  const findingIds: string[] = [];
  if (input.findings.length > 0) {
    const rows = await tx
      .insert(findings)
      .values(
        input.findings.map((f) => {
          const evidenceId = evidenceIds.get(f.evidenceKey);
          if (!evidenceId)
            throw new Error(`finding ${f.code} cites unknown evidence ${f.evidenceKey}`);
          return {
            orgId: input.orgId,
            runId: input.runId,
            source: input.source,
            code: f.code,
            severity: f.severity,
            evidenceId,
            locator: f.locator.slice(0, 4096),
            discriminator: f.discriminator ?? null,
            message: f.message.slice(0, 4000),
            fingerprint: f.fingerprint,
          };
        }),
      )
      .returning({ id: findings.id });
    for (const r of rows) findingIds.push(r.id);
  }
  return { evidenceIds, findingIds };
}

export async function listRunFindings(
  tx: TenantTx,
  runId: string,
): Promise<{ finding: FindingRow; evidence: EvidenceRow }[]> {
  return tx
    .select({ finding: findings, evidence })
    .from(findings)
    .innerJoin(evidence, eq(evidence.id, findings.evidenceId))
    .where(eq(findings.runId, runId))
    .orderBy(asc(findings.createdAt));
}

export async function getEvidence(tx: TenantTx, id: string): Promise<EvidenceRow | null> {
  const [row] = await tx.select().from(evidence).where(eq(evidence.id, id));
  return row ?? null;
}

export async function getEvidenceByIds(tx: TenantTx, ids: string[]): Promise<EvidenceRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(evidence)
    .where(and(inArray(evidence.id, ids)));
}
