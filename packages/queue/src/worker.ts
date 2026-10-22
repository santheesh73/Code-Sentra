import type { JobType, RunStepStatus } from "@codesentra/core";
import {
  childRuns,
  type Database,
  failRun,
  finishRun,
  finishStep,
  getRunWithSteps,
  markRunRunning,
  type RunWithSteps,
  type StepOutcome,
  schema,
  startStep,
  type TenantTx,
} from "@codesentra/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import type { QueueClient } from "./client.js";
import { publishRunEvent } from "./events.js";
import { JOB_SPECS, type RunJobPayload } from "./jobs.js";

export interface StepContext {
  signal: AbortSignal;
  run: RunWithSteps;
}

/** A step returns its outcome; throwing marks the step (and run) failed. */
export type StepFn = (ctx: StepContext) => Promise<StepOutcome>;

export interface JobContext {
  db: Database;
  payload: RunJobPayload;
  run: RunWithSteps;
  signal: AbortSignal;
  /** When the job was enqueued; lets steps measure queue latency. */
  enqueuedAt: Date;
  attempt: number;
  /** Runs one declared step: marks it running, records its outcome, emits progress. */
  step(name: string, fn: StepFn): Promise<StepOutcome>;
  /** For work whose phases are reported by a callee (e.g. Pulse check groups). */
  beginStep(name: string): Promise<void>;
  endStep(name: string, outcome: StepOutcome): Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerOptions {
  db: Database;
  queue: QueueClient;
  handlers: Partial<Record<JobType, JobHandler>>;
  concurrency?: number;
  log?: Logger;
  /** How often to reconcile runs whose jobs died without the handler finishing. */
  sweepIntervalMs?: number;
}

export interface Worker {
  stop(): Promise<void>;
  /** Runs one reconciliation pass now (exposed for tests). */
  sweep(): Promise<number>;
}

const silent: Logger = { info() {}, error() {} };
const TERMINAL = new Set(["succeeded", "failed", "partial"]);

/**
 * Job-completion hook (Section 5): when a run that feeds a Link run finishes, and every
 * sibling has finished too, enqueue the Link run. The job id is the run id, so siblings
 * finishing at the same moment enqueue it once (ADR 0019).
 */
export async function startLinkIfReady(
  db: Database,
  queue: QueueClient,
  orgId: string,
  runId: string,
): Promise<boolean> {
  const parent = await db.withOrg(orgId, async (tx) => {
    const [r] = await tx
      .select({ parent: schema.runs.parentRunId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    if (!r?.parent) return null;
    const [p] = await tx.select().from(schema.runs).where(eq(schema.runs.id, r.parent));
    if (p?.type !== "link" || p.status !== "queued") return null;
    const kids = await childRuns(tx, p.id);
    return kids.length > 0 && kids.every((k) => TERMINAL.has(k.status)) ? p : null;
  });
  if (!parent) return false;
  await queue.enqueue("link.run", { runId: parent.id, orgId });
  return true;
}

async function emitStep(
  db: Database,
  p: RunJobPayload,
  step: string,
  change: (tx: TenantTx) => Promise<unknown>,
  status: RunStepStatus,
): Promise<void> {
  await db.withOrg(p.orgId, async (tx) => {
    await change(tx);
    await publishRunEvent(tx, { kind: "step", runId: p.runId, orgId: p.orgId, step, status });
  });
}

export async function startWorker(opts: WorkerOptions): Promise<Worker> {
  const { db, queue } = opts;
  const log = opts.log ?? silent;
  const workerIds: string[] = [];

  // Link still runs when a child failed: it records what is missing (Section 5).
  const afterFinish = async (orgId: string, runId: string) => {
    try {
      await startLinkIfReady(db, queue, orgId, runId);
    } catch (e) {
      log.error({ runId, err: (e as Error).message }, "could not start the Link run");
    }
  };

  const runJob = async (type: JobType, handler: JobHandler, job: JobWithMetadata<unknown>) => {
    const payload = JOB_SPECS[type].payload.parse(job.data);
    const started = await db.withOrg(payload.orgId, async (tx) => {
      const ok = await markRunRunning(tx, payload.runId);
      if (ok) await publishRunEvent(tx, { kind: "run", ...payload, status: "running" });
      return ok;
    });
    if (!started) {
      log.info(
        { runId: payload.runId, type },
        "run is not runnable (already finished); skipping job",
      );
      return;
    }
    const run = await db.withOrg(payload.orgId, (tx) => getRunWithSteps(tx, payload.runId));
    if (!run) throw new Error(`run ${payload.runId} disappeared`);

    const declared = (name: string) => {
      if (!run.steps.some((s) => s.name === name)) throw new Error(`undeclared step ${name}`);
    };
    const ctx: JobContext = {
      db,
      payload,
      run,
      signal: job.signal,
      enqueuedAt: job.createdOn,
      attempt: job.retryCount + 1,
      async beginStep(name) {
        declared(name);
        await emitStep(db, payload, name, (tx) => startStep(tx, payload.runId, name), "running");
      },
      async endStep(name, outcome) {
        declared(name);
        await emitStep(
          db,
          payload,
          name,
          (tx) => finishStep(tx, payload.runId, name, outcome),
          outcome.status,
        );
      },
      async step(name, fn) {
        declared(name);
        await emitStep(db, payload, name, (tx) => startStep(tx, payload.runId, name), "running");
        let outcome: StepOutcome;
        try {
          if (job.signal.aborted) throw new Error("job timed out before the step started");
          outcome = await fn({ signal: job.signal, run });
        } catch (e) {
          outcome = { status: "failed", error: (e as Error).message || String(e) };
        }
        await emitStep(
          db,
          payload,
          name,
          (tx) => finishStep(tx, payload.runId, name, outcome),
          outcome.status,
        );
        return outcome;
      },
    };

    try {
      await handler(ctx);
      const unfinished = await db.withOrg(payload.orgId, async (tx) => {
        const r = await getRunWithSteps(tx, payload.runId);
        return (r?.steps ?? []).filter((s) => s.status === "pending" || s.status === "running");
      });
      if (unfinished.length > 0) {
        throw new Error(
          `handler returned with unfinished steps: ${unfinished.map((s) => s.name).join(", ")}`,
        );
      }
      await db.withOrg(payload.orgId, async (tx) => {
        const status = await finishRun(tx, payload.runId);
        await publishRunEvent(tx, { kind: "run", ...payload, status });
      });
      await afterFinish(payload.orgId, payload.runId);
    } catch (e) {
      const finalAttempt = job.retryCount >= job.retryLimit;
      log.error(
        {
          runId: payload.runId,
          type,
          attempt: ctx.attempt,
          finalAttempt,
          err: (e as Error).message,
        },
        "job failed",
      );
      if (finalAttempt) {
        await db.withOrg(payload.orgId, async (tx) => {
          await failRun(tx, payload.runId, (e as Error).message);
          await publishRunEvent(tx, { kind: "run", ...payload, status: "failed" });
        });
        await afterFinish(payload.orgId, payload.runId);
      }
      throw e;
    }
  };

  for (const [type, handler] of Object.entries(opts.handlers) as [JobType, JobHandler][]) {
    const id = await queue.boss.work(
      type,
      {
        includeMetadata: true,
        batchSize: 1,
        localConcurrency: opts.concurrency ?? 2,
        pollingIntervalSeconds: 0.5,
      },
      async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) await runJob(type, handler, job);
      },
    );
    workerIds.push(id);
  }

  /**
   * A process crash or an expired final attempt leaves the run "running" with no
   * handler alive. pg-boss records the job as failed; this pass marks such runs
   * failed so nothing stays green or pending forever.
   */
  const sweep = async (): Promise<number> => {
    const dead = await db.system.execute<{ id: string; org_id: string; output: unknown }>(sql`
      select r.id, r.org_id, j.output
      from ${schema.runs} r
      join pgboss.job j on j.id = r.id
      where r.status in ('queued', 'running') and j.state = 'failed'
      limit 100`);
    for (const row of dead.rows) {
      const reason = `job failed without finishing the run${row.output ? `: ${JSON.stringify(row.output).slice(0, 500)}` : ""}`;
      await db.withOrg(row.org_id, async (tx) => {
        const [r] = await tx
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(
            and(eq(schema.runs.id, row.id), inArray(schema.runs.status, ["queued", "running"])),
          );
        if (!r) return;
        await failRun(tx, row.id, reason);
        await publishRunEvent(tx, {
          kind: "run",
          runId: row.id,
          orgId: row.org_id,
          status: "failed",
        });
      });
      await afterFinish(row.org_id, row.id);
    }
    return dead.rows.length;
  };
  const timer = setInterval(() => {
    sweep().catch((e) => log.error({ err: (e as Error).message }, "sweep failed"));
  }, opts.sweepIntervalMs ?? 60_000);
  timer.unref();

  return {
    sweep,
    async stop() {
      clearInterval(timer);
      for (const type of Object.keys(opts.handlers)) await queue.boss.offWork(type, { wait: true });
    },
  };
}
