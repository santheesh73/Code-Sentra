import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRun,
  failRun,
  finishRun,
  finishStep,
  getRunWithSteps,
  markRunRunning,
  startStep,
} from "./queries/runs.js";
import * as s from "./schema.js";
import { startTestDatabase, type TestDatabase } from "./testing.js";

/** Drizzle wraps driver errors; assert on the Postgres message in `cause`. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; cause?: { message?: string } };
    return `${err.cause?.message ?? ""} | ${err.message}`;
  }
  throw new Error("expected the query to fail");
}

let t: TestDatabase;
let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
let projectA: string;
let projectB: string;

beforeAll(async () => {
  t = await startTestDatabase();
  const sys = t.db.system;
  const [a, b] = await sys
    .insert(s.organizations)
    .values([
      { name: "A", slug: "org-a" },
      { name: "B", slug: "org-b" },
    ])
    .returning();
  orgA = a!.id;
  orgB = b!.id;
  const [ua, ub] = await sys
    .insert(s.users)
    .values([{ email: "a@example.com" }, { email: "b@example.com" }])
    .returning();
  userA = ua!.id;
  userB = ub!.id;
  await sys.insert(s.memberships).values([
    { orgId: orgA, userId: userA, role: "owner" },
    { orgId: orgB, userId: userB, role: "owner" },
  ]);
  const [pa, pb] = await sys
    .insert(s.projects)
    .values([
      { orgId: orgA, name: "alpha" },
      { orgId: orgB, name: "beta" },
    ])
    .returning();
  projectA = pa!.id;
  projectB = pb!.id;
  await sys.insert(s.sessions).values({
    userId: userA,
    tokenHash: "0".repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
  });
});

afterAll(async () => {
  await t?.stop();
});

describe("row-level security (ADR 0009)", () => {
  it("returns only the current org's rows even without a WHERE clause", async () => {
    const rows = await t.db.withOrg(orgA, (tx) => tx.select().from(s.projects));
    expect(rows.map((r) => r.id)).toEqual([projectA]);
    const orgs = await t.db.withOrg(orgA, (tx) => tx.select().from(s.organizations));
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it("cannot read another org's row by id", async () => {
    const rows = await t.db.withOrg(orgA, (tx) =>
      tx.select().from(s.projects).where(eq(s.projects.id, projectB)),
    );
    expect(rows).toEqual([]);
  });

  it("cannot insert rows for another org", async () => {
    expect(
      await pgError(
        t.db.withOrg(orgA, (tx) => tx.insert(s.projects).values({ orgId: orgB, name: "smuggled" })),
      ),
    ).toMatch(/row-level security/);
  });

  it("cannot update or delete another org's rows", async () => {
    const updated = await t.db.withOrg(orgA, (tx) =>
      tx.update(s.projects).set({ name: "pwned" }).where(eq(s.projects.id, projectB)).returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await t.db.withOrg(orgA, (tx) =>
      tx.delete(s.projects).where(eq(s.projects.id, projectB)).returning(),
    );
    expect(deleted).toEqual([]);
    const [b] = await t.db.system.select().from(s.projects).where(eq(s.projects.id, projectB));
    expect(b?.name).toBe("beta");
  });

  it("cannot move a row to another org", async () => {
    expect(
      await pgError(
        t.db.withOrg(orgA, (tx) =>
          tx.update(s.projects).set({ orgId: orgB }).where(eq(s.projects.id, projectA)),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("sees only users who are members of the current org", async () => {
    const rows = await t.db.withOrg(orgA, (tx) =>
      tx.select({ id: s.users.id, email: s.users.email }).from(s.users),
    );
    expect(rows.map((r) => r.id)).toEqual([userA]);
  });

  it("has no access to authentication tables", async () => {
    expect(await pgError(t.db.withOrg(orgA, (tx) => tx.select().from(s.sessions)))).toMatch(
      /permission denied/,
    );
    expect(await pgError(t.db.withOrg(orgA, (tx) => tx.select().from(s.magicLinkTokens)))).toMatch(
      /permission denied/,
    );
    expect(await pgError(t.db.withOrg(orgA, (tx) => tx.select().from(s.authIdentities)))).toMatch(
      /permission denied/,
    );
  });

  it("documents the boundary: raw SQL can leave the tenant scope (ADR 0009)", async () => {
    // RESET ROLE regains the connection role, and set_config moves the org. Neither is
    // reachable from user input: tenant code never runs raw SQL built from requests.
    const viaReset = await t.db.withOrg(orgA, async (tx) => {
      await tx.execute(sql`reset role`);
      return tx.select().from(s.projects);
    });
    expect(viaReset).toHaveLength(2);
    const viaSetConfig = await t.db.withOrg(orgA, async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${orgB}, true)`);
      return tx.select().from(s.projects);
    });
    expect(viaSetConfig.map((r) => r.id)).toEqual([projectB]);
  });

  it("sees nothing when no org is set", async () => {
    const rows = await t.db.system.transaction(async (tx) => {
      await tx.execute(sql`set local role codesentra_app`);
      return tx.select().from(s.projects);
    });
    expect(rows).toEqual([]);
  });

  it("rejects malformed org ids", async () => {
    await expect(t.db.withOrg("' or 1=1 --", async () => 1)).rejects.toThrow(/UUID/);
  });

  it("enforces org consistency between parent and child rows", async () => {
    expect(
      await pgError(
        t.db.system
          .insert(s.environments)
          .values({ orgId: orgA, projectId: projectB, name: "production", url: "https://x.dev" }),
      ),
    ).toMatch(/environments_project_fk/);
  });
});

describe("run lifecycle queries", () => {
  it("creates a run with ordered pending steps", async () => {
    const { run, steps } = await t.db.withOrg(orgA, (tx) =>
      createRun(tx, {
        orgId: orgA,
        projectId: projectA,
        type: "diagnostic",
        trigger: "manual",
        requestedBy: userA,
        steps: ["database", "queue", "object_storage"],
      }),
    );
    expect(run.status).toBe("queued");
    expect(steps.map((x) => [x.name, x.status, x.position])).toEqual([
      ["database", "pending", 0],
      ["queue", "pending", 1],
      ["object_storage", "pending", 2],
    ]);
  });

  it("derives partial when a step is skipped, never succeeded", async () => {
    const status = await t.db.withOrg(orgA, async (tx) => {
      const { run } = await createRun(tx, {
        orgId: orgA,
        projectId: projectA,
        type: "diagnostic",
        trigger: "manual",
        steps: ["a", "b"],
      });
      expect(await markRunRunning(tx, run.id)).toBe(true);
      await startStep(tx, run.id, "a");
      const a = await finishStep(tx, run.id, "a", { status: "done", log: "ok" });
      expect(a.durationMs).toBeGreaterThanOrEqual(0);
      await finishStep(tx, run.id, "b", { status: "skipped", gapReason: "not configured" });
      return finishRun(tx, run.id);
    });
    expect(status).toBe("partial");
  });

  it("failRun fails running steps and records unstarted ones as skipped with a reason", async () => {
    const result = await t.db.withOrg(orgA, async (tx) => {
      const { run } = await createRun(tx, {
        orgId: orgA,
        type: "diagnostic",
        trigger: "manual",
        steps: ["a", "b", "c"],
      });
      await markRunRunning(tx, run.id);
      await startStep(tx, run.id, "a");
      await finishStep(tx, run.id, "a", { status: "done" });
      await startStep(tx, run.id, "b");
      await failRun(tx, run.id, "worker crashed");
      return getRunWithSteps(tx, run.id);
    });
    expect(result?.run.status).toBe("failed");
    expect(result?.steps.map((x) => x.status)).toEqual(["done", "failed", "skipped"]);
    expect(result?.steps[2]?.gapReason).toMatch(/failed before/);
  });

  it("refuses a skipped step without a reason, in code and in the schema", async () => {
    await expect(
      t.db.withOrg(orgA, async (tx) => {
        const { run } = await createRun(tx, {
          orgId: orgA,
          type: "diagnostic",
          trigger: "manual",
          steps: ["a"],
        });
        await finishStep(tx, run.id, "a", { status: "skipped", gapReason: " " });
      }),
    ).rejects.toThrow(/gap reason/);
    expect(
      await pgError(
        t.db.withOrg(orgA, async (tx) => {
          const { run } = await createRun(tx, {
            orgId: orgA,
            type: "diagnostic",
            trigger: "manual",
            steps: ["a"],
          });
          await tx
            .update(s.runSteps)
            .set({ status: "skipped" })
            .where(eq(s.runSteps.runId, run.id));
        }),
      ),
    ).toMatch(/run_steps_skipped_has_reason/);
  });

  it("cannot read another org's run", async () => {
    const { run } = await t.db.withOrg(orgB, (tx) =>
      createRun(tx, {
        orgId: orgB,
        projectId: projectB,
        type: "diagnostic",
        trigger: "manual",
        steps: ["x"],
      }),
    );
    expect(await t.db.withOrg(orgA, (tx) => getRunWithSteps(tx, run.id))).toBeNull();
  });
});
