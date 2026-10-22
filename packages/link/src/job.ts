import {
  type DraftContext,
  draftIssues,
  type FindingLike,
  type IssueDraftOut,
} from "@codesentra/checks";
import { type FindingCode, type JsonObject, LinkStep } from "@codesentra/core";
import {
  childRuns,
  documentedEnvVars,
  type IssueDraft,
  listRunFindings,
  loadCodeGraph,
  type RunRow,
  schema as s,
  scanSourceFor,
  setRunOutcome,
  syncIssues,
  type TenantTx,
} from "@codesentra/db";
import type { PromptTrace } from "@codesentra/prompts";
import type { JobContext, JobHandler } from "@codesentra/queue";
import { and, desc, eq, sql } from "drizzle-orm";
import { blastRadius } from "./blast.js";
import { type LinkGraph, type Trace, traceFinding } from "./trace.js";

/** Steps of a Link run (Section 10). */
export const LINK_STEPS: readonly LinkStep[] = LinkStep.options;

interface Source {
  module: "scan" | "pulse";
  /** The child run; issue sightings are recorded against the run whose findings they are. */
  run: RunRow;
  findingsRunId: string;
  environmentId: string | null;
  environmentName: string | null;
  targetUrl: string;
  ranGroups: string[];
  findings: { finding: FindingLike & { id: string }; evidence: JsonObject }[];
  evidence: { key: string; kind: string; locator: string; payload: JsonObject }[];
  platform: DraftContext["platform"];
  lastLive: string | null;
}

const TERMINAL_OK = new Set(["succeeded", "partial"]);

async function lastLiveOf(tx: TenantTx, environmentId: string): Promise<string | null> {
  const [r] = await tx
    .select({ finishedAt: s.runs.finishedAt })
    .from(s.runs)
    .where(
      and(
        eq(s.runs.environmentId, environmentId),
        eq(s.runs.type, "pulse"),
        sql`${s.runs.outcome}->>'pulse_status' = 'live'`,
      ),
    )
    .orderBy(desc(s.runs.finishedAt))
    .limit(1);
  return r?.finishedAt?.toISOString() ?? null;
}

async function loadSources(
  tx: TenantTx,
  kids: RunRow[],
  scan: { runId: string; evidenceRunId: string } | null,
  gaps: string[],
): Promise<Source[]> {
  const out: Source[] = [];
  for (const kid of kids) {
    const isPulse = kid.type === "pulse" || kid.type === "recheck";
    const label = isPulse ? `Pulse of ${kid.targetUrl}` : "Scan";
    // A Scan whose model stages failed still stored its graph and findings: use them.
    const usableScan = !isPulse && scan?.runId === kid.id;
    if (!TERMINAL_OK.has(kid.status) && !usableScan) {
      gaps.push(
        `${label} ${kid.status}${kid.error ? `: ${kid.error}` : ""}; its issues were not re-checked`,
      );
      continue;
    }
    const o = (kid.outcome ?? {}) as {
      groups_ran?: string[];
      platform?: Source["platform"];
      cached?: boolean;
    };
    const findingsRunId = !isPulse && scan && scan.runId === kid.id ? scan.evidenceRunId : kid.id;
    const rows = await listRunFindings(tx, findingsRunId);
    const [env] = kid.environmentId
      ? await tx.select().from(s.environments).where(eq(s.environments.id, kid.environmentId))
      : [];
    out.push({
      module: isPulse ? "pulse" : "scan",
      run: kid,
      findingsRunId,
      environmentId: isPulse ? kid.environmentId : null,
      environmentName: env?.name ?? null,
      targetUrl: isPulse ? (kid.targetUrl ?? "") : "",
      ranGroups: o.groups_ran ?? [],
      findings: rows.map((r) => ({
        finding: {
          id: r.finding.id,
          code: r.finding.code,
          severity: r.finding.severity,
          evidenceKey: r.evidence.id,
          locator: r.finding.locator,
          discriminator: r.finding.discriminator,
          message: r.finding.message,
        },
        evidence: r.evidence.payload as JsonObject,
      })),
      evidence: [...new Map(rows.map((r) => [r.evidence.id, r.evidence])).values()].map((e) => ({
        key: e.id,
        kind: e.kind,
        locator: e.locator,
        payload: e.payload as JsonObject,
      })),
      platform: isPulse ? (o.platform ?? null) : null,
      lastLive: isPulse && kid.environmentId ? await lastLiveOf(tx, kid.environmentId) : null,
    });
  }
  return out;
}

/**
 * link.run (Section 10): for every finished child run (Scan, Pulse per environment,
 * re-checks), trace each issue's leading finding to code with exact joins only, widen
 * verified traces to their blast radius, write each issue's prompt (code_fix when
 * traced), then open, re-see, resolve or regress the project's issues. A failed child
 * or a missing Scan is a recorded gap, never a pass.
 */
export function linkHandler(): JobHandler {
  return async (ctx: JobContext) => {
    const { run } = ctx.run;
    const orgId = ctx.payload.orgId;
    if (!run.projectId) throw new Error("a Link run needs a project");
    const projectId = run.projectId;
    const gaps: string[] = [];

    const loaded = await ctx.db.withOrg(orgId, async (tx) => {
      const kids = await childRuns(tx, run.id);
      const [project] = await tx.select().from(s.projects).where(eq(s.projects.id, projectId));
      const scanKid = kids.find((k) => k.type === "scan") ?? null;
      const scan = await scanSourceFor(tx, projectId, scanKid?.id ?? null);
      const graph = scan ? await loadCodeGraph(tx, scan.snapshotId) : null;
      const documented = scan ? await documentedEnvVars(tx, scan.evidenceRunId) : new Set<string>();
      const sources = await loadSources(tx, kids, scan, gaps);
      return { kids, project, scan, graph, documented, sources };
    });
    if (loaded.kids.length === 0) throw new Error("the Link run has no child runs");

    const graph: LinkGraph | null = loaded.graph
      ? {
          nodes: loaded.graph.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            path: n.path,
            name: n.name,
            line: n.line,
            meta: n.meta as Record<string, unknown>,
          })),
          edges: loaded.graph.edges.map((e) => ({
            fromId: e.fromId,
            toId: e.toId,
            kind: e.kind,
            weight: e.weight,
          })),
          documentedEnv: loaded.documented,
        }
      : null;
    const noScan =
      "no Scan of this project has finished yet, so issues cannot be traced to code (they get investigate prompts)";

    // --- trace -------------------------------------------------------------------------
    const traces = new Map<string, Trace>(); // `${source}:${leaderIndex}`
    const keyOf = (si: number, idx: number) => `${si}:${idx}`;
    const draftsFor = (
      src: Source,
      traceOf?: (leader: FindingLike & { index: number }) => {
        trace: PromptTrace | null;
        reclassifiedAs: FindingCode | null;
      },
    ): IssueDraftOut[] =>
      draftIssues(
        src.findings.map((f) => f.finding),
        src.evidence,
        {
          target: { url: src.targetUrl, environment: src.environmentName },
          project: loaded.project
            ? { name: loaded.project.name, repoUrl: loaded.project.repoUrl }
            : null,
          platform: src.platform,
          lastSuccessfulCheck: src.lastLive,
          scanSummary: null,
          ...(traceOf ? { traceOf: (leader) => traceOf({ ...leader, index: leader.index }) } : {}),
        },
      );

    await ctx.step("trace", async () => {
      if (!graph) return { status: "skipped", gapReason: noScan };
      let verified = 0;
      const misses: string[] = [];
      loaded.sources.forEach((src, si) => {
        draftsFor(src, (leader) => {
          const t = traceFinding(
            {
              code: leader.code,
              locator: leader.locator,
              discriminator: leader.discriminator ?? null,
              message: leader.message,
            },
            graph,
          );
          // Scan sites take their source line from the finding's evidence when the node has none.
          const text = src.findings[leader.index]?.evidence.text;
          for (const site of t.sites)
            if (!site.excerpt && typeof text === "string") site.excerpt = text;
          traces.set(keyOf(si, leader.index), t);
          if (t.verified) verified++;
          else misses.push(`${leader.code} ${leader.locator}: ${t.reason}`);
          return { trace: null, reclassifiedAs: t.reclassifiedAs };
        });
      });
      return {
        status: "done",
        log: [
          `${verified} of ${traces.size} issues traced to code (snapshot ${loaded.scan?.snapshotId})`,
          ...misses.map((m) => `not traced: ${m}`),
        ]
          .join("\n")
          .slice(0, 4000),
      };
    });

    // --- widen -------------------------------------------------------------------------
    const radius = new Map<string, { path: string; reason: string }[]>();
    await ctx.step("widen", async () => {
      if (!graph) return { status: "skipped", gapReason: noScan };
      let files = 0;
      for (const [k, t] of traces) {
        if (!t.verified) continue;
        const r = blastRadius([...new Set(t.sites.map((x) => x.path))], graph).map((e) => ({
          path: e.path,
          reason: e.reason,
        }));
        radius.set(k, r);
        files += r.length;
      }
      return {
        status: "done",
        log: `${radius.size} traced issues, ${files} files in their blast radius`,
      };
    });

    // --- prompt ------------------------------------------------------------------------
    const drafts: { src: Source; si: number; drafts: (IssueDraftOut & { leader: number })[] }[] =
      [];
    await ctx.step("prompt", async () => {
      const counts: Record<string, number> = {};
      loaded.sources.forEach((src, si) => {
        const list = draftsFor(src, (leader) => {
          const t = traces.get(keyOf(si, leader.index));
          return {
            reclassifiedAs: t?.reclassifiedAs ?? null,
            trace:
              t?.verified && t.joinKey
                ? {
                    joinKey: t.joinKey,
                    sites: t.sites.map(({ path, line, symbol, excerpt }) => ({
                      path,
                      line,
                      symbol,
                      excerpt,
                    })),
                    envVars: t.envVars,
                    blastRadius: radius.get(keyOf(si, leader.index)) ?? [],
                  }
                : null,
          };
        }).map((d) => ({ ...d, leader: d.findingIndexes[0] as number }));
        for (const d of list) counts[d.prompt.type] = (counts[d.prompt.type] ?? 0) + 1;
        drafts.push({ src, si, drafts: list });
      });
      return {
        status: "done",
        log:
          Object.entries(counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ") || "no issues",
      };
    });

    // --- verify ------------------------------------------------------------------------
    const totals = { opened: 0, seen: 0, resolved: 0, regressed: 0 };
    await ctx.step("verify", async () => {
      await ctx.db.withOrg(orgId, async (tx) => {
        for (const { src, si, drafts: list } of drafts) {
          const r = await syncIssues(tx, {
            orgId,
            projectId,
            environmentId: src.environmentId,
            runId: src.findingsRunId,
            traceRunId: run.id,
            module: src.module,
            ranGroups: src.ranGroups,
            drafts: list.map((d): IssueDraft => {
              const t = traces.get(keyOf(si, d.leader));
              return {
                fingerprint: d.fingerprint,
                code: d.code,
                severity: d.severity,
                title: d.title,
                locator: d.locator,
                summary: d.summary,
                corroboratingCodes: d.corroboratingCodes,
                findingIds: d.findingIndexes
                  .map((i) => src.findings[i]?.finding.id)
                  .filter((x): x is string => Boolean(x)),
                recheck: d.recheck,
                prompt: d.prompt,
                trace:
                  t?.verified && t.joinKey
                    ? {
                        joinKey: t.joinKey,
                        findingId: src.findings[d.leader]?.finding.id ?? null,
                        sites: t.sites.map((x) => ({
                          nodeId: x.nodeId,
                          path: x.path,
                          line: x.line,
                          symbol: x.symbol,
                          excerpt: x.excerpt,
                        })),
                        envVars: t.envVars,
                        blastRadius: radius.get(keyOf(si, d.leader)) ?? [],
                      }
                    : null,
              };
            }),
          });
          totals.opened += r.opened.length;
          totals.seen += r.seen.length;
          totals.resolved += r.resolved.length;
          totals.regressed += r.regressed.length;
        }
        const traced = [...traces.values()].filter((t) => t.verified).length;
        await setRunOutcome(tx, run.id, {
          issues: totals,
          traced,
          untraced: traces.size - traced,
          snapshot_id: loaded.scan?.snapshotId ?? null,
          sources: loaded.sources.map((x) => ({
            run_id: x.run.id,
            module: x.module,
            environment_id: x.environmentId,
          })),
          gaps: [...(graph ? [] : [noScan]), ...gaps],
        });
      });
      const log = `opened ${totals.opened}, still open ${totals.seen}, resolved ${totals.resolved}, regressed ${totals.regressed}`;
      // A child that did not finish leaves its issues un-checked: the Link run is partial,
      // never green (Rule 2). What did finish was re-checked, as the log says.
      return gaps.length
        ? { status: "skipped", gapReason: `partly: ${gaps.join("; ")}`, log }
        : { status: "done", log };
    });
  };
}
