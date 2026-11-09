import type { Database } from "@codesentra/db";
import { sql } from "drizzle-orm";

export interface DeadLetterJob {
  /** The pg-boss job id. */
  id: string;
  /** The job type, e.g. "scan.run". */
  type: string;
  runId: string | null;
  orgId: string | null;
  attempts: number;
  retryLimit: number;
  failedAt: Date | null;
  /** The last error the handler threw, as recorded by pg-boss (clipped). */
  reason: string | null;
}

type Row = {
  id: string;
  type: string;
  run_id: string | null;
  org_id: string | null;
  retry_count: number;
  retry_limit: number;
  completed_on: Date | string | null;
  output: unknown;
};

function reasonOf(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === "string") return output.slice(0, 500);
  if (typeof output === "object") {
    const o = output as { message?: unknown; value?: { message?: unknown } };
    const msg = o.message ?? o.value?.message;
    if (typeof msg === "string") return msg.slice(0, 500);
  }
  return JSON.stringify(output).slice(0, 500);
}

/**
 * The queue's dead letters: jobs that exhausted their retries and ended in pg-boss's `failed`
 * state (resilience, Section 20). `sweep()` reconciles the owning runs to failed; this exposes
 * the underlying jobs for an operator. Scoped to one org by the orgId carried in the job
 * payload, so an org admin sees only their own. Most recently failed first.
 *
 * pg-boss archives and eventually prunes finished jobs, so this reflects the current retention
 * window, not all history.
 */
export async function deadLetterJobs(
  db: Database,
  opts: { orgId?: string; limit?: number } = {},
): Promise<DeadLetterJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const scope = opts.orgId ? sql`and j.data->>'orgId' = ${opts.orgId}` : sql``;
  const res = await db.system.execute<Row>(sql`
    select j.id::text as id,
           j.name as type,
           j.data->>'runId' as run_id,
           j.data->>'orgId' as org_id,
           j.retry_count,
           j.retry_limit,
           j.completed_on,
           j.output
    from pgboss.job j
    where j.state = 'failed' and j.retry_count >= j.retry_limit
      ${scope}
    order by j.completed_on desc nulls last
    limit ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    runId: r.run_id,
    orgId: r.org_id,
    attempts: r.retry_count + 1,
    retryLimit: r.retry_limit,
    failedAt: r.completed_on ? new Date(r.completed_on) : null,
    reason: reasonOf(r.output),
  }));
}
