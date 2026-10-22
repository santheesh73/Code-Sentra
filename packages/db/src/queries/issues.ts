import {
  type FindingCode,
  type IssueStatus,
  nextIssueStatus,
  type PromptType,
  type RecheckSpec,
  type Severity,
} from "@codesentra/core";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import {
  evidence,
  findings,
  fixPrompts,
  issueEvents,
  issueFindings,
  issues,
  traces,
} from "../schema.js";

export type IssueRow = typeof issues.$inferSelect;
export type IssueEventRow = typeof issueEvents.$inferSelect;
export type FixPromptRow = typeof fixPrompts.$inferSelect;
export type TraceRow = typeof traces.$inferSelect;

export interface IssueDraft {
  fingerprint: string;
  code: FindingCode;
  severity: Severity;
  title: string;
  locator: string;
  summary: string;
  corroboratingCodes: FindingCode[];
  findingIds: string[];
  recheck: RecheckSpec;
  prompt: { type: PromptType; body: string; templateVersion: string };
  /** Sentra Link's verified trace and blast radius; absent leaves stored traces as they are. */
  trace?: {
    joinKey: string;
    findingId: string | null;
    sites: {
      nodeId: string | null;
      path: string;
      line: number | null;
      symbol: string | null;
      excerpt: string | null;
    }[];
    envVars: { name: string; documented: boolean }[];
    blastRadius: { path: string; reason: string }[];
  } | null;
}

export interface SyncResult {
  opened: string[];
  seen: string[];
  regressed: string[];
  resolved: string[];
}

/**
 * Applies one run's findings to the project's issues (Sections 6 and 10d):
 * - a new fingerprint opens an issue with prompt v1;
 * - a known fingerprint records a sighting (a resolved issue regresses);
 * - an open/regressed issue of this environment not seen in this run resolves, but only
 *   if the check group its re-check names actually ran (never on a skip, Rule 2).
 * A changed prompt body becomes a new prompt version.
 */
export async function syncIssues(
  tx: TenantTx,
  input: {
    orgId: string;
    projectId: string;
    environmentId: string | null;
    runId: string;
    module: "scan" | "pulse";
    /** Check groups that ran in this run. */
    ranGroups: string[];
    drafts: IssueDraft[];
    /** The Link run writing the traces (defaults to runId). */
    traceRunId?: string;
  },
): Promise<SyncResult> {
  const result: SyncResult = { opened: [], seen: [], regressed: [], resolved: [] };
  const envMatch = input.environmentId
    ? eq(issues.environmentId, input.environmentId)
    : isNull(issues.environmentId);
  const fingerprints = input.drafts.map((d) => d.fingerprint);
  const known = fingerprints.length
    ? await tx
        .select()
        .from(issues)
        .where(
          and(eq(issues.projectId, input.projectId), inArray(issues.fingerprint, fingerprints)),
        )
    : [];
  const byFp = new Map(known.map((i) => [i.fingerprint, i]));

  const event = (issueId: string, kind: IssueEventRow["kind"]) =>
    tx.insert(issueEvents).values({ orgId: input.orgId, issueId, runId: input.runId, kind });

  for (const d of input.drafts) {
    let issue = byFp.get(d.fingerprint);
    if (!issue) {
      const [created] = await tx
        .insert(issues)
        .values({
          orgId: input.orgId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          fingerprint: d.fingerprint,
          title: d.title,
          code: d.code,
          corroboratingCodes: d.corroboratingCodes,
          severity: d.severity,
          status: "open",
          locator: d.locator,
          summary: d.summary,
          firstSeenRunId: input.runId,
          lastSeenRunId: input.runId,
          recheck: d.recheck,
        })
        .returning();
      if (!created) throw new Error("issue insert failed");
      issue = created;
      await event(issue.id, "opened");
      result.opened.push(issue.id);
    } else {
      const t = nextIssueStatus(issue.status, { checkGroupRan: true, observed: true });
      await tx
        .update(issues)
        .set({
          status: t.status,
          lastSeenRunId: input.runId,
          title: d.title,
          severity: d.severity,
          summary: d.summary,
          corroboratingCodes: d.corroboratingCodes,
          recheck: d.recheck,
        })
        .where(eq(issues.id, issue.id));
      if (t.event) await event(issue.id, t.event);
      if (t.event === "regressed") result.regressed.push(issue.id);
      else if (t.event === "seen") result.seen.push(issue.id);
    }
    if (d.findingIds.length > 0) {
      await tx
        .insert(issueFindings)
        .values(
          d.findingIds.map((findingId) => ({ orgId: input.orgId, issueId: issue.id, findingId })),
        )
        .onConflictDoNothing();
    }
    const [latest] = await tx
      .select()
      .from(fixPrompts)
      .where(eq(fixPrompts.issueId, issue.id))
      .orderBy(desc(fixPrompts.version))
      .limit(1);
    if (!latest || latest.body !== d.prompt.body || latest.type !== d.prompt.type) {
      await tx.insert(fixPrompts).values({
        orgId: input.orgId,
        issueId: issue.id,
        version: (latest?.version ?? 0) + 1,
        type: d.prompt.type,
        body: d.prompt.body,
        blastRadius: d.trace?.blastRadius ?? latest?.blastRadius ?? [],
        templateVersion: d.prompt.templateVersion,
      });
    }
    if (d.trace) {
      await tx.delete(traces).where(eq(traces.issueId, issue.id));
      if (d.trace.sites.length)
        await tx.insert(traces).values(
          d.trace.sites.map((s) => ({
            orgId: input.orgId,
            issueId: issue.id,
            findingId: d.trace?.findingId ?? null,
            codeNodeId: s.nodeId,
            runId: input.traceRunId ?? input.runId,
            joinKey: d.trace?.joinKey ?? "",
            verified: true,
            path: s.path,
            line: s.line,
            symbol: s.symbol,
            excerpt: s.excerpt,
            envVars: d.trace?.envVars ?? [],
          })),
        );
    }
  }

  // Re-check every other open issue of this environment and module.
  const seenFp = new Set(fingerprints);
  const candidates = await tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.projectId, input.projectId),
        envMatch,
        inArray(issues.status, ["open", "regressed"]),
      ),
    );
  for (const issue of candidates) {
    if (seenFp.has(issue.fingerprint)) continue;
    const recheck = issue.recheck as RecheckSpec;
    if (recheck.module !== input.module) continue;
    const t = nextIssueStatus(issue.status, {
      checkGroupRan: input.ranGroups.includes(recheck.check_group),
      observed: false,
    });
    if (t.status !== issue.status) {
      await tx
        .update(issues)
        .set({
          status: t.status,
          resolvedRunId: t.status === "resolved" ? input.runId : issue.resolvedRunId,
        })
        .where(eq(issues.id, issue.id));
    }
    if (t.event) {
      await event(issue.id, t.event);
      if (t.event === "resolved") result.resolved.push(issue.id);
    }
  }
  return result;
}

const SEVERITY_ORDER = sql`case ${issues.severity} when 'error' then 0 when 'warning' then 1 else 2 end`;

export async function listIssues(
  tx: TenantTx,
  projectId: string,
  filter: { status?: IssueStatus[]; severity?: Severity[]; source?: ("scan" | "pulse")[] } = {},
): Promise<IssueRow[]> {
  const conds = [eq(issues.projectId, projectId)];
  if (filter.status?.length) conds.push(inArray(issues.status, filter.status));
  if (filter.severity?.length) conds.push(inArray(issues.severity, filter.severity));
  if (filter.source?.length)
    conds.push(inArray(sql<string>`${issues.recheck}->>'module'`, filter.source));
  return tx
    .select()
    .from(issues)
    .where(and(...conds))
    .orderBy(SEVERITY_ORDER, desc(issues.updatedAt));
}

export async function getIssueDetail(tx: TenantTx, issueId: string) {
  const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) return null;
  const events = await tx
    .select()
    .from(issueEvents)
    .where(eq(issueEvents.issueId, issueId))
    .orderBy(asc(issueEvents.createdAt));
  const observed = await tx
    .select({ finding: findings, evidence })
    .from(issueFindings)
    .innerJoin(findings, eq(findings.id, issueFindings.findingId))
    .innerJoin(evidence, eq(evidence.id, findings.evidenceId))
    .where(and(eq(issueFindings.issueId, issueId), eq(findings.runId, issue.lastSeenRunId)))
    .orderBy(asc(findings.createdAt));
  const prompt = await getFixPrompt(tx, issueId);
  const traceRows = await tx
    .select()
    .from(traces)
    .where(eq(traces.issueId, issueId))
    .orderBy(asc(traces.path), asc(traces.line));
  return { issue, events, observed, prompt, traces: traceRows };
}

export async function getFixPrompt(
  tx: TenantTx,
  issueId: string,
  version?: number,
): Promise<FixPromptRow | null> {
  const [row] = await tx
    .select()
    .from(fixPrompts)
    .where(
      version
        ? and(eq(fixPrompts.issueId, issueId), eq(fixPrompts.version, version))
        : eq(fixPrompts.issueId, issueId),
    )
    .orderBy(desc(fixPrompts.version))
    .limit(1);
  return row ?? null;
}

/** Dismissal is an explicit, audited user decision; re-checks never change it. */
export async function dismissIssue(
  tx: TenantTx,
  input: { orgId: string; issueId: string; actorId: string; reason: string },
): Promise<IssueRow | null> {
  const [row] = await tx
    .update(issues)
    .set({ status: "dismissed", dismissedReason: input.reason })
    .where(eq(issues.id, input.issueId))
    .returning();
  if (!row) return null;
  await tx.insert(issueEvents).values({
    orgId: input.orgId,
    issueId: row.id,
    kind: "dismissed",
    actorId: input.actorId,
    note: input.reason,
  });
  return row;
}

export async function countOpenIssues(
  tx: TenantTx,
  projectIds: string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await tx
    .select({ projectId: issues.projectId, n: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(inArray(issues.projectId, projectIds), inArray(issues.status, ["open", "regressed"])),
    )
    .groupBy(issues.projectId);
  return new Map(rows.map((r) => [r.projectId, r.n]));
}
