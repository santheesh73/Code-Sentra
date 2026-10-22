import { type JobType, LinkStep, nextCronRun, type RunTrigger } from "@codesentra/core";
import {
  type CreateRunInput,
  createRun,
  type Database,
  failRun,
  schema,
  setRunOutcome,
  type TenantTx,
} from "@codesentra/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { QueueClient } from "./client.js";
import { publishRunEvent } from "./events.js";
import { startLinkIfReady } from "./worker.js";

export interface ChildRun {
  job: JobType;
  run: Omit<CreateRunInput, "orgId" | "projectId" | "parentRunId" | "trigger" | "requestedBy">;
  /** Initial outcome (a re-check carries the group it targets). */
  outcome?: Record<string, unknown>;
}

export interface StartLinkedInput {
  orgId: string;
  projectId: string;
  /** null for runs a webhook or schedule starts (no person requested them). */
  userId: string | null;
  children: ChildRun[];
  trigger?: RunTrigger;
  /** The Link run's initial outcome, e.g. { mode: "pr", changed_files } (ADR 0021). */
  linkOutcome?: Record<string, unknown>;
  /** Runs in the same transaction, before anything is enqueued (e.g. the check row). */
  onCreated?: (tx: TenantTx, linkRunId: string, childRunIds: string[]) => Promise<void>;
}

/**
 * Creates a Link run and its child runs (Section 5) and enqueues the children. When the
 * last child finishes, the queue's completion hook enqueues the Link run (ADR 0019). A
 * child that cannot be enqueued is failed with the reason, and Link still runs on the rest.
 */
export async function startLinked(
  deps: { db: Database; queue: QueueClient },
  input: StartLinkedInput,
): Promise<{ linkRunId: string; childRunIds: string[] }> {
  const created = await deps.db.withOrg(input.orgId, async (tx) => {
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
      await deps.queue.enqueue(k.job, { runId: k.id, orgId: input.orgId });
    } catch (e) {
      await deps.db.withOrg(input.orgId, (tx) =>
        failRun(tx, k.id, `could not enqueue: ${(e as Error).message}`),
      );
      await startLinkIfReady(deps.db, deps.queue, input.orgId, k.id).catch(() => {});
    }
  }
  return { linkRunId: created.linkRunId, childRunIds: created.kids.map((k) => k.id) };
}

export interface DueSchedulesResult {
  started: { scheduleId: string; linkRunId: string }[];
  failed: { scheduleId: string; error: string }[];
}

/**
 * The `schedule.tick` work (Section 5): claims schedules that are due, moves each one's
 * `next_run_at` forward in the same transaction (FOR UPDATE SKIP LOCKED, so any number of
 * workers can tick without starting a schedule twice), then starts each one's Pulse with
 * its Link run. A missed window is not replayed: the next run is the next match after now.
 */
export async function runDueSchedules(
  deps: { db: Database; queue: QueueClient; pulseSteps: readonly string[] },
  now: Date = new Date(),
  limit = 25,
): Promise<DueSchedulesResult> {
  const claimed = await deps.db.system.transaction(async (tx) => {
    const due = await tx
      .select({ schedule: schema.schedules, env: schema.environments })
      .from(schema.schedules)
      .innerJoin(schema.environments, eq(schema.environments.id, schema.schedules.environmentId))
      .where(and(eq(schema.schedules.enabled, true), lte(schema.schedules.nextRunAt, now)))
      .orderBy(asc(schema.schedules.nextRunAt))
      .limit(limit)
      .for("update", { of: schema.schedules, skipLocked: true });
    for (const { schedule } of due) {
      let next: Date;
      try {
        next = nextCronRun(schedule.cron, now);
      } catch {
        await tx
          .update(schema.schedules)
          .set({ enabled: false, lastError: "the cron expression never matches" })
          .where(eq(schema.schedules.id, schedule.id));
        continue;
      }
      await tx
        .update(schema.schedules)
        .set({ nextRunAt: next, lastRunAt: now, updatedAt: sql`now()` })
        .where(eq(schema.schedules.id, schedule.id));
    }
    return due;
  });

  const result: DueSchedulesResult = { started: [], failed: [] };
  for (const { schedule, env } of claimed) {
    try {
      const { linkRunId } = await startLinked(deps, {
        orgId: schedule.orgId,
        projectId: schedule.projectId,
        userId: null,
        trigger: "schedule",
        children: [
          {
            job: "pulse.run",
            run: {
              type: "pulse",
              environmentId: env.id,
              targetUrl: env.url,
              steps: [...deps.pulseSteps],
            },
          },
        ],
        linkOutcome: { mode: "sync", schedule_id: schedule.id },
      });
      await deps.db.withOrg(schedule.orgId, (tx) =>
        tx
          .update(schema.schedules)
          .set({ lastRunId: linkRunId, lastError: null })
          .where(eq(schema.schedules.id, schedule.id)),
      );
      result.started.push({ scheduleId: schedule.id, linkRunId });
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      await deps.db
        .withOrg(schedule.orgId, (tx) =>
          tx
            .update(schema.schedules)
            .set({ lastError: error })
            .where(eq(schema.schedules.id, schedule.id)),
        )
        .catch(() => {});
      result.failed.push({ scheduleId: schedule.id, error });
    }
  }
  return result;
}
