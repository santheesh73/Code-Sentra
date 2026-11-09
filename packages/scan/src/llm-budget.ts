import type { Database, TenantTx } from "@codesentra/db";
import { schema as s } from "@codesentra/db";
import { gte, sql } from "drizzle-orm";
import type { ReportModel } from "./model.js";

export type ModelChoice = { model: ReportModel } | { model: null; reason: string };

/**
 * LLM cost cap (Section 17/20). The report model is the only paid dependency; an unbounded
 * org could run it without limit. When an org's input+output tokens this calendar month have
 * reached the configured cap, Scan stops calling the model and records a gap instead of report
 * prose — the deterministic scan (map, probes, audits, health score) still runs in full.
 *
 * Pure so it is unit-testable; the month-to-date total comes from orgTokensThisMonth().
 */
export function capModel(
  configured: ModelChoice,
  budget: { used: number; cap: number },
): ModelChoice {
  if (budget.cap > 0 && budget.used >= budget.cap) {
    return {
      model: null,
      reason: `the monthly LLM token budget of ${budget.cap.toLocaleString("en-US")} was reached (${budget.used.toLocaleString("en-US")} used this month); report prose was not generated`,
    };
  }
  return configured;
}

/**
 * Sum of input+output LLM tokens recorded on this org's scan runs since the start of the
 * current month. Reads the runs table under the org's RLS scope, so it only ever counts the
 * caller's own org (the tx must already be org-scoped via withOrg).
 */
export async function orgTokensThisMonth(tx: TenantTx, orgId: string): Promise<number> {
  const res = await tx.execute<{ total: string | null }>(sql`
    select coalesce(sum(
      coalesce((${s.runs.outcome} -> 'tokens' ->> 'input')::bigint, 0) +
      coalesce((${s.runs.outcome} -> 'tokens' ->> 'output')::bigint, 0)
    ), 0) as total
    from ${s.runs}
    where ${s.runs.orgId} = ${orgId}
      and ${gte(s.runs.createdAt, sql`date_trunc('month', now())`)}`);
  return Number(res.rows[0]?.total ?? 0);
}

/** Convenience: the effective model for an org this month, given the configured model and cap. */
export async function modelWithinBudget(
  db: Database,
  orgId: string,
  configured: ModelChoice,
  cap: number,
): Promise<ModelChoice> {
  if (cap <= 0) return configured;
  const used = await db.withOrg(orgId, (tx) => orgTokensThisMonth(tx, orgId));
  return capModel(configured, { used, cap });
}
