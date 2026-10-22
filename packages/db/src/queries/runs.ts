import {
  deriveRunStatus,
  type RunStatus,
  type RunStepStatus,
  type RunTrigger,
  type RunType,
} from "@codesentra/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { runSteps, runs } from "../schema.js";

export type RunRow = typeof runs.$inferSelect;
export type RunStepRow = typeof runSteps.$inferSelect;
export interface RunWithSteps {
  run: RunRow;
  steps: RunStepRow[];
}

const LOG_LIMIT = 16_000;
const clip = (s: string | null | undefined, n = LOG_LIMIT) =>
  s == null ? null : s.length > n ? `${s.slice(0, n)}\n… [truncated]` : s;

export interface CreateRunInput {
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  type: RunType;
  trigger: RunTrigger;
  requestedBy?: string | null;
  targetUrl?: string | null;
  parentRunId?: string | null;
  /** Ordered step names; each becomes a pending run_step. */
  steps: readonly string[];
}

export async function createRun(tx: TenantTx, input: CreateRunInput): Promise<RunWithSteps> {
  if (input.steps.length === 0) throw new Error("createRun: a run needs at least one step");
  if (new Set(input.steps).size !== input.steps.length)
    throw new Error("createRun: duplicate step names");
  const [run] = await tx
    .insert(runs)
    .values({
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      environmentId: input.environmentId ?? null,
      type: input.type,
      trigger: input.trigger,
      requestedBy: input.requestedBy ?? null,
      targetUrl: input.targetUrl ?? null,
      parentRunId: input.parentRunId ?? null,
    })
    .returning();
  if (!run) throw new Error("createRun: insert returned no row");
  const steps = await tx
    .insert(runSteps)
    .values(
      input.steps.map((name, position) => ({ orgId: input.orgId, runId: run.id, name, position })),
    )
    .returning();
  return { run, steps: steps.sort((a, b) => a.position - b.position) };
}

export async function getRunWithSteps(tx: TenantTx, runId: string): Promise<RunWithSteps | null> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const steps = await tx
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.position));
  return { run, steps };
}

/** queued → running. Returns false when the run is not queued (e.g. a retried job). */
export async function markRunRunning(tx: TenantTx, runId: string): Promise<boolean> {
  const updated = await tx
    .update(runs)
    .set({ status: "running", startedAt: sql`coalesce(${runs.startedAt}, now())` })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning({ id: runs.id });
  return updated.length > 0;
}

export async function startStep(tx: TenantTx, runId: string, name: string): Promise<void> {
  const updated = await tx
    .update(runSteps)
    .set({
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      gapReason: null,
    })
    .where(and(eq(runSteps.runId, runId), eq(runSteps.name, name)))
    .returning({ id: runSteps.id });
  if (updated.length === 0) throw new Error(`startStep: no step ${name} on run ${runId}`);
}

export type StepOutcome =
  | { status: "done"; log?: string }
  | { status: "skipped"; gapReason: string; log?: string }
  | { status: "failed"; error: string; log?: string };

export async function finishStep(
  tx: TenantTx,
  runId: string,
  name: string,
  outcome: StepOutcome,
): Promise<RunStepRow> {
  if (outcome.status === "skipped" && !outcome.gapReason.trim()) {
    throw new Error("finishStep: a skipped step needs a gap reason (Rule 2)");
  }
  const [row] = await tx
    .update(runSteps)
    .set({
      status: outcome.status,
      finishedAt: new Date(),
      durationMs: sql`case when ${runSteps.startedAt} is null then null else greatest(0, (extract(epoch from (now() - ${runSteps.startedAt})) * 1000)::int) end`,
      gapReason: outcome.status === "skipped" ? outcome.gapReason : null,
      error: outcome.status === "failed" ? clip(outcome.error, 4000) : null,
      log: clip(outcome.log),
    })
    .where(and(eq(runSteps.runId, runId), eq(runSteps.name, name)))
    .returning();
  if (!row) throw new Error(`finishStep: no step ${name} on run ${runId}`);
  return row;
}

/** Records a module-specific outcome summary (e.g. Pulse status and gaps). */
export async function setRunOutcome(
  tx: TenantTx,
  runId: string,
  outcome: Record<string, unknown>,
): Promise<void> {
  await tx.update(runs).set({ outcome }).where(eq(runs.id, runId));
}

/** Sets the terminal status derived from the steps (Rule 2: skipped → partial). */
export async function finishRun(tx: TenantTx, runId: string): Promise<RunStatus> {
  const steps = await tx
    .select({ status: runSteps.status })
    .from(runSteps)
    .where(eq(runSteps.runId, runId));
  const status = deriveRunStatus(steps as { status: RunStepStatus }[]);
  await tx.update(runs).set({ status, finishedAt: new Date() }).where(eq(runs.id, runId));
  return status;
}

/**
 * Terminal failure (crash, timeout, retries exhausted). Running steps fail; steps
 * that never started are recorded as skipped with the reason, never as passes.
 */
export async function failRun(tx: TenantTx, runId: string, error: string): Promise<void> {
  const message = clip(error, 4000) ?? "unknown error";
  await tx
    .update(runSteps)
    .set({ status: "failed", finishedAt: new Date(), error: message })
    .where(and(eq(runSteps.runId, runId), eq(runSteps.status, "running")));
  await tx
    .update(runSteps)
    .set({ status: "skipped", gapReason: "not run: the run failed before this step started" })
    .where(and(eq(runSteps.runId, runId), eq(runSteps.status, "pending")));
  await tx
    .update(runs)
    .set({ status: "failed", finishedAt: new Date(), error: message })
    .where(eq(runs.id, runId));
}
