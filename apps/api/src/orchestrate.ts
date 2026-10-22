import { type JobType, LinkStep } from "@codesentra/core";
import {
  type CreateRunInput,
  createRun,
  failRun,
  setRunOutcome,
  type TenantTx,
} from "@codesentra/db";
import { publishRunEvent, startLinkIfReady } from "@codesentra/queue";
import type { AppContext } from "./context.js";

export interface ChildRun {
  job: JobType;
  run: Omit<CreateRunInput, "orgId" | "projectId" | "parentRunId" | "trigger" | "requestedBy">;
  /** Initial outcome (a re-check carries the group it targets). */
  outcome?: Record<string, unknown>;
}

/**
 * Creates a Link run and its child runs (Section 5) and enqueues the children. When the
 * last child finishes, the queue's completion hook enqueues the Link run (ADR 0019). A
 * child that cannot be enqueued is failed with the reason, and Link still runs on the rest.
 */
export async function startLinked(
  ctx: AppContext,
  input: {
    orgId: string;
    projectId: string;
    /** null for runs a webhook or schedule starts (no person requested them). */
    userId: string | null;
    children: ChildRun[];
    trigger?: "manual" | "webhook" | "schedule" | "cli";
    /** The Link run's initial outcome, e.g. { mode: "pr", changed_files } (ADR 0021). */
    linkOutcome?: Record<string, unknown>;
    /** Runs in the same transaction, before anything is enqueued (e.g. the check row). */
    onCreated?: (tx: TenantTx, linkRunId: string, childRunIds: string[]) => Promise<void>;
  },
): Promise<{ linkRunId: string; childRunIds: string[] }> {
  const created = await ctx.db.withOrg(input.orgId, async (tx) => {
    const link = await createRun(tx, {
      orgId: input.orgId,
      projectId: input.projectId,
      type: "link",
      trigger: input.trigger ?? "manual",
      requestedBy: input.userId,
      steps: LinkStep.options,
    });
    if (input.linkOutcome) await setRunOutcome(tx, link.run.id, input.linkOutcome);
    const kids: { id: string; job: JobType }[] = [];
    for (const c of input.children) {
      const child = await createRun(tx, {
        ...c.run,
        orgId: input.orgId,
        projectId: input.projectId,
        parentRunId: link.run.id,
        trigger: input.trigger ?? "manual",
        requestedBy: input.userId,
      });
      if (c.outcome) await setRunOutcome(tx, child.run.id, c.outcome);
      kids.push({ id: child.run.id, job: c.job });
    }
    if (input.onCreated)
      await input.onCreated(
        tx,
        link.run.id,
        kids.map((k) => k.id),
      );
    for (const id of [link.run.id, ...kids.map((k) => k.id)])
      await publishRunEvent(tx, { kind: "run", runId: id, orgId: input.orgId, status: "queued" });
    return { linkRunId: link.run.id, kids };
  });
  for (const k of created.kids) {
    try {
      await ctx.queue.enqueue(k.job, { runId: k.id, orgId: input.orgId });
    } catch (e) {
      await ctx.db.withOrg(input.orgId, (tx) =>
        failRun(tx, k.id, `could not enqueue: ${(e as Error).message}`),
      );
      await startLinkIfReady(ctx.db, ctx.queue, input.orgId, k.id).catch(() => {});
    }
  }
  return { linkRunId: created.linkRunId, childRunIds: created.kids.map((k) => k.id) };
}
