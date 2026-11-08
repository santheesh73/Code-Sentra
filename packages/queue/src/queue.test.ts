import { createRun, getRunWithSteps, type RunWithSteps, schema as s } from "@codesentra/db";
import { startTestDatabase, type TestDatabase } from "@codesentra/db/testing";
import { createObjectStore, type ObjectStore } from "@codesentra/storage";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type QueueClient, startQueueClient } from "./client.js";
import { DIAGNOSTIC_STEPS, diagnosticHandler } from "./diagnostic.js";
import { createRunEventListener, type RunEvent, type RunEventListener } from "./events.js";
import { type JobContext, startWorker, type Worker, type WorkerOptions } from "./worker.js";

let t: TestDatabase;
let queue: QueueClient;
let listener: RunEventListener;
let minio: StartedTestContainer;
let store: ObjectStore;
let orgId: string;
let projectId: string;

const MINIO_USER = "cs-test-user";
const MINIO_PASSWORD = "cs-test-password-0123456789";

beforeAll(async () => {
  [t, minio] = await Promise.all([
    startTestDatabase(),
    new GenericContainer("pgsty/minio:RELEASE.2026-08-04T00-00-00Z")
      .withCommand(["server", "/data"])
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
      .start(),
  ]);
  const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const mb = await minio.exec([
    "sh",
    "-c",
    `mc alias set l http://127.0.0.1:9000 ${MINIO_USER} ${MINIO_PASSWORD} && mc mb l/cs-test`,
  ]);
  expect(mb.exitCode, mb.output).toBe(0);
  store = createObjectStore({
    endpoint,
    bucket: "cs-test",
    accessKeyId: MINIO_USER,
    secretAccessKey: MINIO_PASSWORD,
  });
  queue = await startQueueClient(t.url, { retryDelaySeconds: 1 });
  listener = await createRunEventListener(t.url);
  const [org] = await t.db.system
    .insert(s.organizations)
    .values({ name: "Q", slug: "q" })
    .returning();
  orgId = org!.id;
  const [p] = await t.db.system.insert(s.projects).values({ orgId, name: "q" }).returning();
  projectId = p!.id;
}, 180_000);

afterAll(async () => {
  await listener?.close();
  await queue?.stop();
  await Promise.all([t?.stop(), minio?.stop()]);
});

async function newRun(steps: readonly string[] = DIAGNOSTIC_STEPS): Promise<RunWithSteps> {
  return t.db.withOrg(orgId, (tx) =>
    createRun(tx, { orgId, projectId, type: "diagnostic", trigger: "manual", steps }),
  );
}

/** Collects events for a run until a terminal run event arrives. */
function collect(runId: string, timeoutMs = 30_000): Promise<RunEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RunEvent[] = [];
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out; got ${JSON.stringify(events)}`));
    }, timeoutMs);
    const off = listener.subscribe(runId, (e) => {
      events.push(e);
      if (e.kind === "run" && ["succeeded", "failed", "partial"].includes(e.status)) {
        clearTimeout(timer);
        off();
        resolve(events);
      }
    });
  });
}

const summary = (events: RunEvent[]) =>
  events.map((e) => (e.kind === "run" ? `run:${e.status}` : `${e.step}:${e.status}`));

describe("diagnostic job end to end", () => {
  let worker: Worker;
  afterAll(async () => worker?.stop());

  it("runs every step against real Postgres and MinIO, emitting live progress", async () => {
    worker = await startWorker({
      db: t.db,
      queue,
      handlers: { "system.diagnostic": diagnosticHandler({ store }) },
    });
    const { run } = await newRun();
    const done = collect(run.id);
    expect(await queue.enqueue("system.diagnostic", { runId: run.id, orgId })).toBe(true);
    expect(summary(await done)).toEqual([
      "run:running",
      "database:running",
      "database:done",
      "queue:running",
      "queue:done",
      "object_storage:running",
      "object_storage:done",
      "run:succeeded",
    ]);
    const final = await t.db.withOrg(orgId, (tx) => getRunWithSteps(tx, run.id));
    expect(final?.run.status).toBe("succeeded");
    expect(final?.run.startedAt).toBeInstanceOf(Date);
    expect(final?.steps.find((x) => x.name === "database")?.log).toMatch(/Postgres 16\./);
    expect(final?.steps.find((x) => x.name === "object_storage")?.log).toMatch(/cs-test/);
    await worker.stop();
  });

  it("is idempotent per run id", async () => {
    const { run } = await newRun();
    expect(await queue.enqueue("system.diagnostic", { runId: run.id, orgId })).toBe(true);
    expect(await queue.enqueue("system.diagnostic", { runId: run.id, orgId })).toBe(false);
  });

  it("reports partial with a named gap when object storage is not configured", async () => {
    worker = await startWorker({
      db: t.db,
      queue,
      handlers: { "system.diagnostic": diagnosticHandler({ store: null }) },
    });
    const { run } = await newRun();
    const done = collect(run.id);
    await queue.enqueue("system.diagnostic", { runId: run.id, orgId });
    expect(summary(await done).at(-1)).toBe("run:partial");
    const final = await t.db.withOrg(orgId, (tx) => getRunWithSteps(tx, run.id));
    const storage = final?.steps.find((x) => x.name === "object_storage");
    expect(storage?.status).toBe("skipped");
    expect(storage?.gapReason).toMatch(/not configured/);
    await worker.stop();
  });

  it("marks the run failed after the final retry, never leaving it running", async () => {
    let attempts = 0;
    worker = await startWorker({
      db: t.db,
      queue,
      handlers: {
        "system.diagnostic": async (ctx) => {
          attempts++;
          await ctx.step("database", async () => ({ status: "done" }));
          throw new Error("boom on purpose");
        },
      },
    });
    const { run } = await newRun();
    const done = collect(run.id, 90_000);
    await queue.enqueue("system.diagnostic", { runId: run.id, orgId });
    expect(summary(await done).at(-1)).toBe("run:failed");
    expect(attempts).toBe(4);
    const final = await t.db.withOrg(orgId, (tx) => getRunWithSteps(tx, run.id));
    expect(final?.run.error).toMatch(/boom on purpose/);
    expect(final?.steps.map((x) => x.status)).toEqual(["done", "skipped", "skipped"]);
    await worker.stop();
  }, 120_000);

  it("rejects payloads that are not a run reference", async () => {
    await expect(
      queue.enqueue("system.diagnostic", { runId: "nope", orgId } as never),
    ).rejects.toThrow();
  });
});

describe("sweep", () => {
  it("fails runs whose job died without finishing", async () => {
    const worker = await startWorker({ db: t.db, queue, handlers: {} });
    const { run } = await newRun(["a"]);
    await queue.boss.send("pulse.run", { runId: run.id, orgId }, { id: run.id, retryLimit: 0 });
    const [job] = await queue.boss.fetch("pulse.run");
    expect(job?.id).toBe(run.id);
    await queue.boss.fail("pulse.run", run.id, { message: "worker lost" });
    expect(await worker.sweep()).toBe(1);
    const final = await t.db.withOrg(orgId, (tx) => getRunWithSteps(tx, run.id));
    expect(final?.run.status).toBe("failed");
    expect(final?.run.error).toMatch(/worker lost/);
    expect(final?.steps[0]?.status).toBe("skipped");
    await worker.stop();
  });
});

/**
 * Production runs several worker replicas against one Postgres-backed queue. These tests
 * stand up independent pg-boss clients (each one is a separate "process" with its own pool)
 * competing for the same queue, and assert the guarantees a horizontally scaled fleet must
 * keep: each run is handled exactly once (pg-boss SELECT … FOR UPDATE SKIP LOCKED hands a
 * job to a single replica), nothing is dropped, work spreads across replicas, and a transient
 * failure is retried — by whichever replica next claims it — without finalizing the run twice.
 */
describe("multiple worker replicas against one queue", () => {
  async function fleet(
    size: number,
    handlers: WorkerOptions["handlers"],
  ): Promise<{ clients: QueueClient[]; workers: Worker[]; stop(): Promise<void> }> {
    const clients: QueueClient[] = [];
    const workers: Worker[] = [];
    for (let i = 0; i < size; i++) {
      // ensureQueues:false — the shared client created the queues in beforeAll; replicas only
      // join. Separate clients ⇒ separate pools ⇒ a faithful multi-process fleet.
      const client = await startQueueClient(t.url, {
        retryDelaySeconds: 1,
        ensureQueues: false,
      });
      clients.push(client);
      workers.push(await startWorker({ db: t.db, queue: client, concurrency: 2, handlers }));
    }
    return {
      clients,
      workers,
      async stop() {
        await Promise.all(workers.map((w) => w.stop()));
        await Promise.all(clients.map((c) => c.stop()));
      },
    };
  }

  const okSteps = async (ctx: { step: JobContext["step"] }) => {
    await ctx.step("database", async () => ({ status: "done" as const }));
    await ctx.step("queue", async () => ({ status: "done" as const }));
    await ctx.step("object_storage", async () => ({ status: "done" as const }));
  };

  it("processes each run exactly once across replicas, with no loss", async () => {
    const REPLICAS = 3;
    const RUNS = 12;
    const handledPerRun = new Map<string, number>();
    const handledPerReplica = new Map<number, number>();

    const clients: QueueClient[] = [];
    const workers: Worker[] = [];
    for (let i = 0; i < REPLICAS; i++) {
      const client = await startQueueClient(t.url, { retryDelaySeconds: 1, ensureQueues: false });
      clients.push(client);
      workers.push(
        await startWorker({
          db: t.db,
          queue: client,
          concurrency: 2,
          handlers: {
            "system.diagnostic": async (ctx) => {
              handledPerRun.set(ctx.payload.runId, (handledPerRun.get(ctx.payload.runId) ?? 0) + 1);
              handledPerReplica.set(i, (handledPerReplica.get(i) ?? 0) + 1);
              await okSteps(ctx);
            },
          },
        }),
      );
    }

    const runs = await Promise.all(Array.from({ length: RUNS }, () => newRun()));
    const dones = runs.map((r) => collect(r.run.id, 60_000));
    for (const { run } of runs) {
      expect(await queue.enqueue("system.diagnostic", { runId: run.id, orgId })).toBe(true);
    }
    const results = await Promise.all(dones);

    // No loss: every run reached a terminal success event.
    for (const events of results) expect(summary(events).at(-1)).toBe("run:succeeded");
    // Exactly once: each run's handler body ran a single time, and every run is accounted for.
    expect(handledPerRun.size).toBe(RUNS);
    for (const [runId, count] of handledPerRun) expect(count, `run ${runId}`).toBe(1);
    expect([...handledPerRun.values()].reduce((a, b) => a + b, 0)).toBe(RUNS);
    // Horizontally scaled: the work did not all land on one replica.
    const replicasThatWorked = [...handledPerReplica.values()].filter((n) => n > 0).length;
    expect(replicasThatWorked).toBeGreaterThanOrEqual(2);
    // The database agrees each run succeeded.
    for (const { run } of runs) {
      const final = await t.db.withOrg(orgId, (tx) => getRunWithSteps(tx, run.id));
      expect(final?.run.status).toBe("succeeded");
    }

    await Promise.all(workers.map((w) => w.stop()));
    await Promise.all(clients.map((c) => c.stop()));
  }, 120_000);

  it("retries a transient failure on the fleet without finalizing the run twice", async () => {
    const attempts = new Map<string, number>();
    const completions = new Map<string, number>();
    const f = await fleet(2, {
      "system.diagnostic": async (ctx) => {
        attempts.set(ctx.payload.runId, (attempts.get(ctx.payload.runId) ?? 0) + 1);
        await ctx.step("database", async () => ({ status: "done" }));
        // First claim fails after partial work, as if the replica were lost mid-job.
        if (ctx.attempt === 1) throw new Error("transient: replica lost the job");
        await ctx.step("queue", async () => ({ status: "done" }));
        await ctx.step("object_storage", async () => ({ status: "done" }));
        completions.set(ctx.payload.runId, (completions.get(ctx.payload.runId) ?? 0) + 1);
      },
    });

    const { run } = await newRun();
    const done = collect(run.id, 60_000);
    await queue.enqueue("system.diagnostic", { runId: run.id, orgId });
    expect(summary(await done).at(-1)).toBe("run:succeeded");

    // Retried exactly once (attempt 1 failed, attempt 2 succeeded), finalized exactly once —
    // the second claim may be served by either replica, but the run completes a single time.
    expect(attempts.get(run.id)).toBe(2);
    expect(completions.get(run.id)).toBe(1);
    const final = await t.db.withOrg(orgId, (tx) => getRunWithSteps(tx, run.id));
    expect(final?.run.status).toBe("succeeded");
    expect(final?.steps.map((x) => x.status)).toEqual(["done", "done", "done"]);

    await f.stop();
  }, 120_000);
});
