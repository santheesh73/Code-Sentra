import { randomBytes } from "node:crypto";
import type { ObjectStore } from "@codesentra/storage";
import { sql } from "drizzle-orm";
import type { JobHandler } from "./worker.js";

/** Steps of a `diagnostic` run, in order. The API creates runs with exactly these. */
export const DIAGNOSTIC_STEPS = ["database", "queue", "object_storage"] as const;

/**
 * Verifies the platform end to end (ADR 0008): a tenant-scoped database round trip,
 * the queue's pickup latency, and an object-storage write/read/delete. Every step does
 * real work; a step that cannot run is skipped with the reason, never reported as passed.
 */
export function diagnosticHandler(deps: { store: ObjectStore | null }): JobHandler {
  return async (ctx) => {
    await ctx.step("database", async () => {
      const t0 = performance.now();
      const result = await ctx.db.withOrg(ctx.payload.orgId, async (tx) => {
        const r = await tx.execute<{ version: string; org: string | null }>(
          sql`select current_setting('server_version') as version, app_current_org()::text as org`,
        );
        return r.rows[0];
      });
      const ms = Math.round(performance.now() - t0);
      if (result?.org !== ctx.payload.orgId) {
        return { status: "failed", error: "tenant scope was not applied to the transaction" };
      }
      return {
        status: "done",
        log: `Postgres ${result.version}; tenant-scoped round trip in ${ms} ms`,
      };
    });

    await ctx.step("queue", async () => {
      const latency = Date.now() - ctx.enqueuedAt.getTime();
      return {
        status: "done",
        log: `job picked up ${latency} ms after it was enqueued (attempt ${ctx.attempt})`,
      };
    });

    await ctx.step("object_storage", async ({ signal }) => {
      if (!deps.store) {
        return {
          status: "skipped",
          gapReason:
            "object storage is not configured (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY unset)",
        };
      }
      const key = `diagnostics/${ctx.payload.orgId}/${ctx.payload.runId}.bin`;
      const body = randomBytes(64);
      const t0 = performance.now();
      await deps.store.put(key, body, "application/octet-stream");
      try {
        if (signal.aborted) throw new Error("timed out");
        const read = await deps.store.get(key);
        if (Buffer.compare(Buffer.from(read), body) !== 0) {
          return { status: "failed", error: "object read back did not match what was written" };
        }
      } finally {
        await deps.store.delete(key);
      }
      const ms = Math.round(performance.now() - t0);
      return {
        status: "done",
        log: `wrote, read back and deleted 64 bytes in bucket ${deps.store.bucket} (${ms} ms)`,
      };
    });
  };
}
