import { RunStatus, RunStepStatus } from "@codesentra/core";
import type { TenantTx } from "@codesentra/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";

export const RUN_EVENTS_CHANNEL = "cs_run_events";

export const RunEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    runId: z.uuid(),
    orgId: z.uuid(),
    status: RunStatus,
    at: z.string(),
  }),
  z.object({
    kind: z.literal("step"),
    runId: z.uuid(),
    orgId: z.uuid(),
    step: z.string(),
    status: RunStepStatus,
    at: z.string(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

type EventInput =
  | { kind: "run"; runId: string; orgId: string; status: RunStatus }
  | { kind: "step"; runId: string; orgId: string; step: string; status: RunStepStatus };

/**
 * Publishes a progress event with pg_notify. Called inside the transaction that
 * changed the row, so listeners are notified only once the change is committed and
 * never see a state the database does not have. Payloads carry ids and statuses only.
 */
export async function publishRunEvent(tx: TenantTx, event: EventInput): Promise<void> {
  const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
  await tx.execute(sql`select pg_notify(${RUN_EVENTS_CHANNEL}, ${payload})`);
}

export interface RunEventListener {
  /** Subscribe to one run's events. Returns an unsubscribe function. */
  subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void;
  close(): Promise<void>;
}

/**
 * One LISTEN connection per process, fanned out to subscribers by run id.
 * Reconnects with backoff; subscribers should re-read state after `onReconnect`
 * because NOTIFY is not replayed.
 */
export async function createRunEventListener(
  connectionString: string,
  opts: { onError?: (e: Error) => void; onReconnect?: () => void } = {},
): Promise<RunEventListener> {
  const subscribers = new Map<string, Set<(e: RunEvent) => void>>();
  let client: pg.Client | null = null;
  let closed = false;
  let attempt = 0;

  const dispatch = (raw: string | undefined) => {
    if (!raw) return;
    let parsed: RunEvent;
    try {
      parsed = RunEvent.parse(JSON.parse(raw));
    } catch (e) {
      opts.onError?.(new Error(`invalid run event: ${(e as Error).message}`));
      return;
    }
    for (const cb of subscribers.get(parsed.runId) ?? []) cb(parsed);
  };

  const connect = async (): Promise<void> => {
    const c = new pg.Client({ connectionString, application_name: "codesentra-run-events" });
    c.on("notification", (msg) => {
      if (msg.channel === RUN_EVENTS_CHANNEL) dispatch(msg.payload);
    });
    c.on("error", (e) => {
      opts.onError?.(e);
      void reconnect();
    });
    await c.connect();
    await c.query(`LISTEN ${RUN_EVENTS_CHANNEL}`);
    client = c;
    attempt = 0;
  };

  const reconnect = async () => {
    const old = client;
    client = null;
    old?.removeAllListeners();
    await old?.end().catch(() => {});
    while (!closed) {
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 250 * 2 ** attempt)));
      try {
        await connect();
        opts.onReconnect?.();
        return;
      } catch (e) {
        opts.onError?.(e as Error);
      }
    }
  };

  await connect();

  return {
    subscribe(runId, onEvent) {
      let set = subscribers.get(runId);
      if (!set) {
        set = new Set();
        subscribers.set(runId, set);
      }
      set.add(onEvent);
      return () => {
        set?.delete(onEvent);
        if (set?.size === 0) subscribers.delete(runId);
      };
    },
    async close() {
      closed = true;
      subscribers.clear();
      await client?.end().catch(() => {});
    },
  };
}
