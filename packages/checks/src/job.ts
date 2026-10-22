import {
  persistRunData,
  type RunWithSteps,
  schema as s,
  setRunOutcome,
  syncIssues,
  type TenantTx,
} from "@codesentra/db";
import type { JobHandler } from "@codesentra/queue";
import type { FetchPolicy } from "@codesentra/ssrf";
import type { ObjectStore } from "@codesentra/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Browser } from "playwright-core";
import { draftIssues, findingFingerprint } from "./issues.js";
import { runPulse } from "./pulse.js";
import type { PulseResult } from "./types.js";

export interface PulseJobDeps {
  policy: FetchPolicy;
  store: ObjectStore | null;
  getBrowser(): Promise<{ browser: Browser } | { browser: null; reason: string }>;
  slowThresholdMs: number;
}

/** Steps of a project Pulse run; Quick Pulse runs have no project and no `issues` step. */
export const PULSE_PROJECT_STEPS = [
  "reachability",
  "platform",
  "render",
  "routes",
  "hygiene",
  "issues",
] as const;

async function loadContext(tx: TenantTx, run: RunWithSteps["run"]) {
  const [project] = run.projectId
    ? await tx.select().from(s.projects).where(eq(s.projects.id, run.projectId))
    : [];
  const [env] = run.environmentId
    ? await tx.select().from(s.environments).where(eq(s.environments.id, run.environmentId))
    : [];
  const [lastLive] = run.environmentId
    ? await tx
        .select({ finishedAt: s.runs.finishedAt })
        .from(s.runs)
        .where(
          and(
            eq(s.runs.environmentId, run.environmentId),
            eq(s.runs.type, "pulse"),
            sql`${s.runs.outcome}->>'pulse_status' = 'live'`,
          ),
        )
        .orderBy(desc(s.runs.finishedAt))
        .limit(1)
    : [];
  return { project: project ?? null, env: env ?? null, lastLive: lastLive?.finishedAt ?? null };
}

/**
 * pulse.run: executes every Pulse check group (each one a run step), stores the
 * screenshot, persists evidence and findings, and for project runs turns them into
 * issues with prompts and re-checks older issues of the same environment.
 */
export function pulseHandler(deps: PulseJobDeps): JobHandler {
  return async (ctx) => {
    const { run } = ctx.run;
    const orgId = ctx.payload.orgId;
    if (!run.targetUrl) throw new Error("pulse run has no target URL");
    const info = await ctx.db.withOrg(orgId, (tx) => loadContext(tx, run));
    const b = await deps.getBrowser();

    const result: PulseResult = await runPulse({
      url: run.targetUrl,
      policy: deps.policy,
      browser: b.browser,
      browserUnavailableReason: b.browser ? undefined : b.reason,
      expectedEnvironment: info.env?.name,
      slowThresholdMs: deps.slowThresholdMs,
      onGroup: async (group, state, detail) => {
        if (state === "running") await ctx.beginStep(group);
        else if (state === "done") await ctx.endStep(group, { status: "done", log: detail });
        else if (state === "skipped")
          await ctx.endStep(group, { status: "skipped", gapReason: detail ?? "not run" });
        else await ctx.endStep(group, { status: "failed", error: detail ?? "failed" });
      },
    });

    // Screenshot: stored when object storage is configured; the evidence says which.
    const shot = result.evidence.find((e) => e.kind === "screenshot");
    if (shot && result.screenshot) {
      if (deps.store) {
        const key = `screenshots/${orgId}/${run.id}.png`;
        await deps.store.put(key, result.screenshot, "image/png");
        shot.payload.storage_key = key;
      } else {
        shot.payload.storage_key = null;
        shot.payload.not_stored = "object storage is not configured";
      }
    }

    const drafts = draftIssues(result.findings, result.evidence, {
      target: { url: run.targetUrl, environment: info.env?.name ?? null },
      project: info.project ? { name: info.project.name, repoUrl: info.project.repoUrl } : null,
      platform: result.platform,
      lastSuccessfulCheck: info.lastLive ? info.lastLive.toISOString() : null,
      scanSummary: null,
    });

    const persisted = await ctx.db.withOrg(orgId, async (tx) => {
      const p = await persistRunData(tx, {
        orgId,
        runId: run.id,
        source: "pulse",
        evidence: result.evidence,
        findings: result.findings.map((f) => ({ ...f, fingerprint: findingFingerprint(f) })),
      });
      await setRunOutcome(tx, run.id, {
        pulse_status: result.status,
        gaps: result.gaps,
        platform: result.platform,
        final_url: result.finalUrl,
        duration_ms: result.durationMs,
        findings: { total: result.findings.length, issues: drafts.length },
      });
      return p;
    });

    if (!run.projectId) return;
    await ctx.step("issues", async () => {
      const projectId = run.projectId as string;
      const r = await ctx.db.withOrg(orgId, (tx) =>
        syncIssues(tx, {
          orgId,
          projectId,
          environmentId: run.environmentId,
          runId: run.id,
          module: "pulse",
          ranGroups: result.groups.filter((g) => g.ran).map((g) => g.group),
          drafts: drafts.map((d) => ({
            ...d,
            findingIds: d.findingIndexes
              .map((i) => persisted.findingIds[i])
              .filter((x): x is string => Boolean(x)),
          })),
        }),
      );
      return {
        status: "done",
        log: `opened ${r.opened.length}, still open ${r.seen.length}, resolved ${r.resolved.length}, regressed ${r.regressed.length}`,
      };
    });
  };
}
