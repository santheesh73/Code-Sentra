import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { codeEdges, codeNodes, evidence, reports, runs } from "../schema.js";
import type { RunRow } from "./runs.js";

/** Runs that feed a Link run (scan, pulse and re-check children), oldest first. */
export async function childRuns(tx: TenantTx, parentRunId: string): Promise<RunRow[]> {
  return tx
    .select()
    .from(runs)
    .where(eq(runs.parentRunId, parentRunId))
    .orderBy(asc(runs.createdAt));
}

/**
 * The scan whose evidence and code graph a run of this project should use: the run's
 * own scan child if it produced a report, else the project's latest finished scan with
 * one. A cached scan points at the run whose evidence it reused.
 */
export async function scanSourceFor(
  tx: TenantTx,
  projectId: string,
  preferRunId: string | null,
): Promise<{ runId: string; evidenceRunId: string; snapshotId: string } | null> {
  const resolve = async (r: RunRow) => {
    const o = r.outcome as { cached?: boolean; source_run_id?: string } | null;
    const evidenceRunId = o?.cached && o.source_run_id ? o.source_run_id : r.id;
    const [src] = await tx
      .select({ snapshotId: runs.snapshotId })
      .from(runs)
      .innerJoin(reports, eq(reports.runId, runs.id))
      .where(eq(runs.id, evidenceRunId));
    return src?.snapshotId ? { runId: r.id, evidenceRunId, snapshotId: src.snapshotId } : null;
  };
  if (preferRunId) {
    const [own] = await tx.select().from(runs).where(eq(runs.id, preferRunId));
    const hit = own ? await resolve(own) : null;
    if (hit) return hit;
  }
  const recent = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.type, "scan"),
        inArray(runs.status, ["succeeded", "partial"]),
        isNotNull(runs.finishedAt),
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .limit(10);
  for (const r of recent) {
    const hit = await resolve(r);
    if (hit) return hit;
  }
  return null;
}

/** A snapshot's stored code graph. */
export async function loadCodeGraph(tx: TenantTx, snapshotId: string) {
  const nodes = await tx.select().from(codeNodes).where(eq(codeNodes.snapshotId, snapshotId));
  const edges = await tx.select().from(codeEdges).where(eq(codeEdges.snapshotId, snapshotId));
  return { nodes, edges };
}

/** Env var names a Scan saw documented (.env.example, README). */
export async function documentedEnvVars(tx: TenantTx, scanRunId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ payload: evidence.payload })
    .from(evidence)
    .where(and(eq(evidence.runId, scanRunId), eq(evidence.kind, "env_var_documented")));
  return new Set(
    rows
      .map((r) => (r.payload as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string"),
  );
}

/** Static GET page routes a Scan found, for Pulse to probe (Phase 4: route probes from Scan). */
export async function scanRoutePaths(tx: TenantTx, snapshotId: string): Promise<string[]> {
  const rows = await tx
    .select({ meta: codeNodes.meta })
    .from(codeNodes)
    .where(
      and(eq(codeNodes.snapshotId, snapshotId), inArray(codeNodes.kind, ["route", "api_handler"])),
    );
  return [
    ...new Set(
      rows
        .map((r) => r.meta as { routePath?: unknown; method?: unknown })
        .filter(
          (m) => typeof m.routePath === "string" && (m.method === "GET" || m.method === "ALL"),
        )
        .map((m) => m.routePath as string),
    ),
  ].sort();
}
