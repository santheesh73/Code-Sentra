import { JobType } from "@codesentra/core";
import { PgBoss } from "pg-boss";
import { JOB_SPECS, type RunJobPayload, timeoutFor } from "./jobs.js";

export const PGBOSS_SCHEMA = "pgboss";

export interface QueueClient {
  boss: PgBoss;
  /**
   * Enqueues the job for a run. The run id is the job id, so enqueueing the same run
   * twice is a no-op. Returns false when the job already existed.
   */
  enqueue(type: JobType, payload: RunJobPayload): Promise<boolean>;
  stop(): Promise<void>;
}

export interface QueueClientOptions {
  /** Create every queue on start (idempotent). Workers and the API both do this. */
  ensureQueues?: boolean;
  env?: Record<string, string | undefined>;
  /** Base retry delay in seconds (exponential backoff on top). Default 2. */
  retryDelaySeconds?: number;
  onError?: (e: Error) => void;
}

export async function startQueueClient(
  connectionString: string,
  opts: QueueClientOptions = {},
): Promise<QueueClient> {
  const boss = new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: "codesentra-queue",
  });
  boss.on("error", (e) => opts.onError?.(e));
  await boss.start();
  if (opts.ensureQueues ?? true) {
    for (const type of JobType.options) {
      const spec = JOB_SPECS[type];
      const options = {
        retryLimit: spec.retryLimit,
        retryBackoff: true,
        retryDelay: opts.retryDelaySeconds ?? 2,
        expireInSeconds: timeoutFor(type, opts.env),
      };
      if (await boss.getQueue(type)) await boss.updateQueue(type, options);
      else await boss.createQueue(type, options);
    }
  }
  return {
    boss,
    async enqueue(type, payload) {
      const data = JOB_SPECS[type].payload.parse(payload);
      const id = await boss.send(type, data, { id: data.runId });
      return id !== null;
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
