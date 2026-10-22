import { type JobType, LinkStep } from "@codesentra/core";
import { type CreateRunInput, createRun, failRun, setRunOutcome } from "@codesentra/db";
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
  input: { orgId: string; projectId: string; userId: string; children: ChildRun[] },
): Promise<{ linkRunId: string; childRunIds: string[] }> {
  const created = await ctx.db.withOrg(input.orgId, async (tx) => {
    const link = await createRun(tx, {
      orgId: input.orgId,
      projectId: input.projectId,
      type: "link",
      trigger: "manual",
      requestedBy: input.userId,
      steps: LinkStep.options,
    });
    const kids: { id: string; job: JobType }[] = [];
    for (const c of input.children) {
      const child = await createRun(tx, {
        ...c.run,
        orgId: input.orgId,
        projectId: input.projectId,
        parentRunId: link.run.id,
        trigger: "manual",
        requestedBy: input.userId,
      });
      if (c.outcome) await setRunOutcome(tx, child.run.id, c.outcome);
      kids.push({ id: child.run.id, job: c.job });
    }
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
