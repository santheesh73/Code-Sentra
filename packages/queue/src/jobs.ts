import type { JobType } from "@codesentra/core";
import { z } from "zod";

/** Every job refers to exactly one run; the run id is also the pg-boss job id (idempotency). */
export const RunJobPayload = z.object({
  runId: z.uuid(),
  orgId: z.uuid(),
  /** W3C traceparent of the enqueuer, so the job's spans join its trace (Section 19). */
  traceparent: z
    .string()
    .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    .optional(),
});
export type RunJobPayload = z.infer<typeof RunJobPayload>;

export interface JobSpec {
  payload: z.ZodType<RunJobPayload>;
  /** Hard timeout; pg-boss expires the attempt and the handler's signal aborts. */
  timeoutSeconds: number;
  retryLimit: number;
}

const minutes = (n: number) => n * 60;

/** Section 5: max 3 retries with exponential backoff; per-type hard timeouts. */
export const JOB_SPECS: Record<JobType, JobSpec> = {
  "scan.run": { payload: RunJobPayload, timeoutSeconds: minutes(15), retryLimit: 3 },
  "scan.incremental": { payload: RunJobPayload, timeoutSeconds: minutes(15), retryLimit: 3 },
  "pulse.run": { payload: RunJobPayload, timeoutSeconds: minutes(2), retryLimit: 3 },
  "link.run": { payload: RunJobPayload, timeoutSeconds: minutes(5), retryLimit: 3 },
  "issue.recheck": { payload: RunJobPayload, timeoutSeconds: minutes(2), retryLimit: 3 },
  "schedule.tick": { payload: RunJobPayload, timeoutSeconds: minutes(1), retryLimit: 3 },
  "system.diagnostic": { payload: RunJobPayload, timeoutSeconds: minutes(1), retryLimit: 3 },
};

/** Timeouts are configurable per deployment: JOB_TIMEOUT_<TYPE> in seconds, e.g. JOB_TIMEOUT_SCAN_RUN=1200. */
export function timeoutFor(
  type: JobType,
  env: Record<string, string | undefined> = process.env,
): number {
  const key = `JOB_TIMEOUT_${type.replace(/\./g, "_").toUpperCase()}`;
  const raw = env[key];
  if (raw === undefined || raw === "") return JOB_SPECS[type].timeoutSeconds;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${key} must be a positive integer number of seconds`);
  return n;
}
