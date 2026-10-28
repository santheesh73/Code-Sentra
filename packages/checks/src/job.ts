import type { PulseCheckGroup } from "@codesentra/core";
import { openSecret } from "@codesentra/core/crypto";
import {
  persistRunData,
  type RunWithSteps,
  schema as s,
  scanRoutePaths,
  scanSourceFor,
  setRunOutcome,
  type TenantTx,
} from "@codesentra/db";
import type { JobHandler } from "@codesentra/queue";
import type { FetchPolicy } from "@codesentra/ssrf";
import type { ObjectStore } from "@codesentra/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Browser } from "playwright-core";
import { draftIssues, findingFingerprint } from "./issues.js";
import { PULSE_GROUPS, runPulse } from "./pulse.js";
import type { PulseResult } from "./types.js";

export interface PulseJobDeps {
  policy: FetchPolicy;
  store: ObjectStore | null;
  getBrowser(): Promise<{ browser: Browser } | { browser: null; reason: string }>;
  slowThresholdMs: number;
  /** ENCRYPTION_KEY, to open an environment's sealed bypass token (Section 9). */
  encryptionKey?: string;
}

/** Purpose bound into sealed bypass tokens (apps/api routes/projects.ts). */
export const BYPASS_PURPOSE = "bypass-token";

/**
 * Steps of a Pulse run: one per check group. Issues are Sentra Link's job (its Link run
 * opens, re-checks and resolves them, ADR 0019); Quick Pulse renders prompts on read.
 */
export const PULSE_STEPS: readonly PulseCheckGroup[] = PULSE_GROUPS;

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
  // Route probes from Scan: static GET routes of the project's latest scanned snapshot.
  const scan = run.projectId ? await scanSourceFor(tx, run.projectId, null) : null;
  const scanRoutes = scan ? await scanRoutePaths(tx, scan.snapshotId) : [];
  return {
    project: project ?? null,
    env: env ?? null,
    lastLive: lastLive?.finishedAt ?? null,
    scanRoutes,
  };
}

/**
 * pulse.run (and issue.recheck): executes the Pulse check groups (each one a run step),
 * stores the screenshot, and persists evidence and findings. A re-check run carries the
 * group it targets in its initial outcome and runs only that (plus its prerequisites).
 */
export function pulseHandler(deps: PulseJobDeps): JobHandler {
  return async (ctx) => {
    const { run } = ctx.run;
    const orgId = ctx.payload.orgId;
    if (!run.targetUrl) throw new Error("pulse run has no target URL");
    const info = await ctx.db.withOrg(orgId, (tx) => loadContext(tx, run));
    const recheck = (run.outcome as { recheck?: { check_group?: string } } | null)?.recheck;
    const only =
      run.type === "recheck" && recheck?.check_group
        ? [recheck.check_group as PulseCheckGroup]
        : undefined;
    // A protected preview's bypass token is sent only to the target's own origin; it is
    // never stored in evidence (request headers are not recorded).
    let bypass: { header: string; value: string } | undefined;
    if (info.env?.bypassTokenRef && deps.encryptionKey) {
      try {
        bypass = JSON.parse(
          openSecret(info.env.bypassTokenRef, deps.encryptionKey, BYPASS_PURPOSE),
        );
      } catch {
        bypass = undefined;
      }
    }
    const b = await deps.getBrowser();

    const result: PulseResult = await runPulse({
      url: run.targetUrl,
      policy: deps.policy,
      browser: b.browser,
      browserUnavailableReason: b.browser ? undefined : b.reason,
      expectedEnvironment: info.env?.name,
      scanRoutes: info.scanRoutes,
      onlyGroups: only,
      slowThresholdMs: deps.slowThresholdMs,
      ...(bypass ? { bypass } : {}),
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

    // Issues a Quick Pulse (or Link) would draft from these findings, for the outcome count.
    const drafts = draftIssues(result.findings, result.evidence, {
      target: { url: run.targetUrl, environment: info.env?.name ?? null },
      project: null,
      platform: result.platform,
      lastSuccessfulCheck: null,
      scanSummary: null,
    });
    await ctx.db.withOrg(orgId, async (tx) => {
      await persistRunData(tx, {
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
        groups_ran: result.groups.filter((g) => g.ran).map((g) => g.group),
        ...(recheck ? { recheck } : {}),
      });
    });
  };
}
