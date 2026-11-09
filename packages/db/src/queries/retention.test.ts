import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema as s } from "../index.js";
import { startTestDatabase, type TestDatabase } from "../testing.js";
import { pruneExpiredRuns } from "./retention.js";
import { createRun } from "./runs.js";

let t: TestDatabase;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  t = await startTestDatabase();
  const [o] = await t.db.system
    .insert(s.organizations)
    .values({ name: "R", slug: "ret" })
    .returning();
  orgId = o!.id;
  const [p] = await t.db.system.insert(s.projects).values({ orgId, name: "shop" }).returning();
  projectId = p!.id;
}, 120_000);
afterAll(async () => t?.stop());

async function run(opts: {
  status?: "queued" | "succeeded" | "failed" | "partial";
  ageDays?: number;
  parentRunId?: string;
}): Promise<string> {
  const { run } = await t.db.withOrg(orgId, (tx) =>
    createRun(tx, {
      orgId,
      projectId,
      type: "pulse",
      trigger: "manual",
      steps: ["render"],
      parentRunId: opts.parentRunId,
    }),
  );
  await t.db.system.execute(sql`
    update runs set status = ${opts.status ?? "succeeded"},
      created_at = now() - make_interval(days => ${opts.ageDays ?? 0})
    where id = ${run.id}`);
  return run.id;
}

async function exists(id: string): Promise<boolean> {
  const r = await t.db.system.execute<{ n: string }>(
    sql`select count(*)::text as n from runs where id = ${id}`,
  );
  return Number(r.rows[0]?.n) > 0;
}

describe("pruneExpiredRuns", () => {
  it("is a no-op when retention is disabled", async () => {
    const old = await run({ ageDays: 400 });
    expect(await pruneExpiredRuns(t.db, 0)).toEqual({ deletedRuns: 0 });
    expect(await exists(old)).toBe(true);
  });

  it("deletes old, terminal, unreferenced, childless runs and keeps the rest", async () => {
    const oldLeaf = await run({ ageDays: 60, status: "succeeded" });
    const recent = await run({ ageDays: 1, status: "succeeded" });
    const oldRunning = await run({ ageDays: 60, status: "queued" });

    // Old run still referenced by an open issue must survive.
    const oldReferenced = await run({ ageDays: 60, status: "failed" });
    await t.db.system.insert(s.issues).values({
      orgId,
      projectId,
      fingerprint: "fp-keep",
      title: "keep",
      code: "UNDEFINED_IN_URL",
      severity: "error",
      locator: "x",
      summary: "s",
      firstSeenRunId: oldReferenced,
      lastSeenRunId: oldReferenced,
      recheck: {},
    });

    // Old parent with an old child: the parent has a child so it stays; the child is a leaf.
    const oldParent = await run({ ageDays: 60, status: "succeeded" });
    const oldChild = await run({ ageDays: 60, status: "succeeded", parentRunId: oldParent });

    const { deletedRuns } = await pruneExpiredRuns(t.db, 30);
    expect(deletedRuns).toBeGreaterThanOrEqual(2);

    expect(await exists(oldLeaf), "old leaf deleted").toBe(false);
    expect(await exists(oldChild), "old childless child deleted").toBe(false);
    expect(await exists(recent), "recent kept").toBe(true);
    expect(await exists(oldRunning), "non-terminal kept").toBe(true);
    expect(await exists(oldReferenced), "issue-referenced kept").toBe(true);
    expect(await exists(oldParent), "run with a child kept").toBe(true);
  });

  it("cascades evidence when a run is pruned", async () => {
    const r = await run({ ageDays: 90, status: "succeeded" });
    await t.db.system.insert(s.evidence).values({
      orgId,
      runId: r,
      kind: "render_summary",
      locator: "l",
      payload: { a: 1 },
      hash: "h",
    });
    await pruneExpiredRuns(t.db, 30);
    expect(await exists(r)).toBe(false);
    const ev = await t.db.system.execute<{ n: string }>(
      sql`select count(*)::text as n from evidence where run_id = ${r}`,
    );
    expect(Number(ev.rows[0]?.n)).toBe(0);
  });
});
