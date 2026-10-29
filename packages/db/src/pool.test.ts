import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client.js";
import { startTestDatabase, type TestDatabase } from "./testing.js";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("connection pool", () => {
  it("survives Postgres ending an idle connection, reporting it to onError", async () => {
    const errors: string[] = [];
    const db = createDatabase(t.url, {
      applicationName: "cs-pool-test",
      onError: (e) => errors.push(e.message),
    });
    await db.system.execute(sql`select 1`);
    // What a restart or failover does to an idle connection.
    await t.db.system.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'cs-pool-test'`,
    );
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]).toMatch(/terminating connection/);
    // The pool dropped that connection and opens a new one.
    const r = await db.system.execute(sql`select 2 as n`);
    expect(r.rows[0]).toEqual({ n: 2 });
    await db.close();
  });

  it("close() returns once every connection has closed", async () => {
    const db = createDatabase(t.url, { applicationName: "cs-pool-close" });
    await Promise.all([1, 2, 3].map(() => db.system.execute(sql`select pg_sleep(0.05)`)));
    expect(db.pool.totalCount).toBeGreaterThan(0);
    await db.close();
    const r = await t.db.system.execute(
      sql`select count(*)::int as n from pg_stat_activity where application_name = 'cs-pool-close'`,
    );
    expect(r.rows[0]).toEqual({ n: 0 });
  });
});
