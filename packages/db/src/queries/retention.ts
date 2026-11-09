import { sql } from "drizzle-orm";
import type { Database } from "../client.js";

export interface RetentionResult {
  deletedRuns: number;
}

/**
 * Data retention (Section 20). Deletes runs older than `days` whose removal cannot harm issue
 * history: a terminal status, not referenced by any issue (first/last/resolved run), and with
 * no child runs (so a Link run and its children are only pruned once the whole family ages
 * out as leaves). Evidence and findings cascade from the run (composite FKs). Object-storage
 * artifacts (snapshots, screenshots) expire through the bucket's own lifecycle policy — see
 * docs/deployment.md. `days <= 0` disables retention and is a no-op.
 *
 * Runs as the maintenance connection across every org; it is the one job that is intentionally
 * cross-tenant, like the stuck-job reaper.
 */
export async function pruneExpiredRuns(db: Database, days: number): Promise<RetentionResult> {
  if (!Number.isFinite(days) || days <= 0) return { deletedRuns: 0 };
  const res = await db.system.execute<{ id: string }>(sql`
    delete from runs r
    where r.created_at < now() - make_interval(days => ${days})
      and r.status in ('succeeded', 'failed', 'partial')
      and not exists (
        select 1 from issues i
        where i.first_seen_run_id = r.id
           or i.last_seen_run_id = r.id
           or i.resolved_run_id = r.id
      )
      and not exists (select 1 from runs c where c.parent_run_id = r.id)
    returning r.id`);
  return { deletedRuns: res.rows.length };
}
