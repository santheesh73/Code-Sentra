import type { JsonValue } from "@codesentra/core";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import {
  claims,
  codeEdges,
  codeNodes,
  evidence,
  features,
  reports,
  runs,
  snapshots,
} from "../schema.js";

export type SnapshotRow = typeof snapshots.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type FeatureRow = typeof features.$inferSelect;

export async function createSnapshot(
  tx: TenantTx,
  input: {
    orgId: string;
    projectId: string;
    kind: "git" | "zip";
    sourceUrl?: string | null;
    ref?: string | null;
    storageKey?: string | null;
    sizeBytes?: number | null;
  },
): Promise<SnapshotRow> {
  const [row] = await tx
    .insert(snapshots)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      kind: input.kind,
      sourceUrl: input.sourceUrl ?? null,
      ref: input.ref ?? null,
      storageKey: input.storageKey ?? null,
      sizeBytes: input.sizeBytes ?? null,
      hasHistory: input.kind === "git",
    })
    .returning();
  return row as SnapshotRow;
}

export async function updateSnapshot(
  tx: TenantTx,
  id: string,
  set: Partial<
    Pick<
      SnapshotRow,
      "treeHash" | "commitSha" | "storageKey" | "sizeBytes" | "fileCount" | "hasHistory"
    >
  >,
): Promise<void> {
  await tx.update(snapshots).set(set).where(eq(snapshots.id, id));
}

/**
 * A finished scan of an identical tree in this project, for cache reuse (Section 8.1).
 * Only runs that produced a report count.
 */
export async function findReusableScan(
  tx: TenantTx,
  input: { projectId: string; treeHash: string; excludeRunId: string },
): Promise<{ runId: string; snapshotId: string } | null> {
  const [row] = await tx
    .select({ runId: runs.id, snapshotId: snapshots.id })
    .from(runs)
    .innerJoin(snapshots, eq(snapshots.id, runs.snapshotId))
    .innerJoin(reports, eq(reports.runId, runs.id))
    .where(
      and(
        eq(runs.projectId, input.projectId),
        eq(runs.type, "scan"),
        inArray(runs.status, ["succeeded", "partial"]),
        ne(runs.id, input.excludeRunId),
        eq(snapshots.treeHash, input.treeHash),
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .limit(1);
  return row ?? null;
}

export interface ScanPersistInput {
  orgId: string;
  runId: string;
  snapshotId: string;
  /** Evidence draft key → id (from persistRunData). */
  evidenceIds: Map<string, string>;
  graph: {
    nodes: {
      key: string;
      kind:
        | "file"
        | "symbol"
        | "route"
        | "api_handler"
        | "cli_command"
        | "env_var"
        | "test"
        | "literal";
      path: string | null;
      name: string;
      line: number | null;
      meta: Record<string, JsonValue>;
    }[];
    edges: {
      from: string;
      to: string;
      kind: "imports" | "calls" | "defines_route" | "reads_env" | "tests" | "co_changes";
      weight: number;
    }[];
  };
  features: {
    name: string;
    status: "complete" | "partial" | "planned";
    reason: string;
    evidenceKeys: string[];
  }[];
  claims: {
    section: string;
    text: string;
    evidenceKeys: string[];
    verified: boolean;
    dropReason: string | null;
    dropDetail: string | null;
  }[];
  report: {
    healthScore: number | null;
    healthBreakdown: JsonValue;
    coverage: JsonValue;
    summary: JsonValue;
    model: string | null;
    usage: JsonValue;
  };
}

const CHUNK = 1000;

/** Stores a scan's graph, features, report and claims; evidence keys become evidence ids. */
export async function persistScanResult(
  tx: TenantTx,
  input: ScanPersistInput,
): Promise<{ reportId: string }> {
  const ids = (keys: string[]) =>
    keys.map((k) => input.evidenceIds.get(k)).filter((x): x is string => !!x);

  const nodeIds = new Map<string, string>();
  for (let i = 0; i < input.graph.nodes.length; i += CHUNK) {
    const chunk = input.graph.nodes.slice(i, i + CHUNK);
    const rows = await tx
      .insert(codeNodes)
      .values(
        chunk.map((n) => ({
          orgId: input.orgId,
          snapshotId: input.snapshotId,
          key: n.key.slice(0, 2000),
          kind: n.kind,
          path: n.path,
          name: n.name.slice(0, 2000),
          line: n.line,
          meta: n.meta,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: codeNodes.id, key: codeNodes.key });
    for (const r of rows) nodeIds.set(r.key, r.id);
  }
  const edgeRows = input.graph.edges
    .map((e) => ({
      from: nodeIds.get(e.from),
      to: nodeIds.get(e.to),
      kind: e.kind,
      weight: e.weight,
    }))
    .filter(
      (
        e,
      ): e is {
        from: string;
        to: string;
        kind: (typeof input.graph.edges)[number]["kind"];
        weight: number;
      } => !!e.from && !!e.to,
    );
  for (let i = 0; i < edgeRows.length; i += CHUNK)
    await tx.insert(codeEdges).values(
      edgeRows.slice(i, i + CHUNK).map((e) => ({
        orgId: input.orgId,
        snapshotId: input.snapshotId,
        fromId: e.from,
        toId: e.to,
        kind: e.kind,
        weight: e.weight,
      })),
    );

  if (input.features.length)
    await tx.insert(features).values(
      input.features.map((f) => ({
        orgId: input.orgId,
        snapshotId: input.snapshotId,
        runId: input.runId,
        name: f.name.slice(0, 200),
        status: f.status,
        reason: f.reason,
        evidenceIds: ids(f.evidenceKeys),
      })),
    );

  const sections: Record<string, { text: string; evidence_ids: string[] }[]> = {};
  for (const c of input.claims.filter((x) => x.verified)) {
    const list = sections[c.section] ?? [];
    list.push({ text: c.text, evidence_ids: ids(c.evidenceKeys) });
    sections[c.section] = list;
  }
  const [report] = await tx
    .insert(reports)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      sections,
      healthScore: input.report.healthScore,
      healthBreakdown: input.report.healthBreakdown,
      claimsTotal: input.claims.length,
      claimsDropped: input.claims.filter((c) => !c.verified).length,
      coverage: input.report.coverage,
      summary: input.report.summary,
      model: input.report.model,
      usage: input.report.usage,
    })
    .returning({ id: reports.id });
  const reportId = (report as { id: string }).id;
  if (input.claims.length)
    await tx.insert(claims).values(
      input.claims.map((c, position) => ({
        orgId: input.orgId,
        reportId,
        position,
        section: c.section,
        text: c.text.slice(0, 2000),
        evidenceIds: ids(c.evidenceKeys),
        verified: c.verified,
        dropReason: c.dropReason,
        dropDetail: c.dropDetail,
      })),
    );
  return { reportId };
}

export interface ReportView {
  report: ReportRow;
  claims: ClaimRow[];
  features: FeatureRow[];
  /** The run whose evidence the report rests on (the cache source, when reused). */
  sourceRunId: string;
}

/** A scan run's report; a cached run serves the report of the run it reused. */
export async function getReport(tx: TenantTx, runId: string): Promise<ReportView | null> {
  const [run] = await tx
    .select({ id: runs.id, outcome: runs.outcome })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!run) return null;
  // A cached run reuses another run's report; parent_run_id is the Link run (ADR 0019).
  const o = run.outcome as { cached?: boolean; source_run_id?: string } | null;
  const sourceRunId = o?.cached === true && o.source_run_id ? o.source_run_id : run.id;
  const [report] = await tx.select().from(reports).where(eq(reports.runId, sourceRunId));
  if (!report) return null;
  const claimRows = await tx
    .select()
    .from(claims)
    .where(eq(claims.reportId, report.id))
    .orderBy(asc(claims.position));
  const featureRows = await tx
    .select()
    .from(features)
    .where(eq(features.runId, sourceRunId))
    .orderBy(asc(features.createdAt));
  return { report, claims: claimRows, features: featureRows, sourceRunId };
}

/** Evidence ids that exist for a run (for verifying cited ids belong to it). */
export async function evidenceIdsOfRun(tx: TenantTx, runId: string): Promise<Set<string>> {
  const rows = await tx.select({ id: evidence.id }).from(evidence).where(eq(evidence.runId, runId));
  return new Set(rows.map((r) => r.id));
}

export async function getSnapshot(tx: TenantTx, id: string): Promise<SnapshotRow | null> {
  const [row] = await tx.select().from(snapshots).where(eq(snapshots.id, id));
  return row ?? null;
}

/** Clears what an earlier attempt of this scan run stored, so a retry never duplicates evidence. */
export async function resetScanRun(tx: TenantTx, runId: string, snapshotId: string): Promise<void> {
  await tx.delete(reports).where(eq(reports.runId, runId));
  await tx.delete(features).where(eq(features.runId, runId));
  await tx.delete(evidence).where(eq(evidence.runId, runId));
  await tx.delete(codeNodes).where(eq(codeNodes.snapshotId, snapshotId));
}
