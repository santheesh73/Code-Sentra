import { createRun, getRunWithSteps, type RunWithSteps, schema as s } from "@codesentra/db";
import { startTestDatabase, type TestDatabase } from "@codesentra/db/testing";
import { createObjectStore, type ObjectStore } from "@codesentra/storage";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type QueueClient, startQueueClient } from "./client.js";
import { DIAGNOSTIC_STEPS, diagnosticHandler } from "./diagnostic.js";
import { createRunEventListener, type RunEvent, type RunEventListener } from "./events.js";
import { startWorker, type Worker } from "./worker.js";

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
