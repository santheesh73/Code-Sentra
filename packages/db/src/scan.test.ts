import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistRunData } from "./queries/findings.js";
import { createRun } from "./queries/runs.js";
import {
  createSnapshot,
  findReusableScan,
  getReport,
  persistScanResult,
  updateSnapshot,
} from "./queries/scan.js";
import * as s from "./schema.js";
import { startTestDatabase, type TestDatabase } from "./testing.js";

let t: TestDatabase;
let orgA: string;
let orgB: string;
let projectId: string;

beforeAll(async () => {
  t = await startTestDatabase();
  const [a, b] = await t.db.system
    .insert(s.organizations)
    .values([
      { name: "A", slug: "sa" },
      { name: "B", slug: "sb" },
    ])
    .returning();
  orgA = a!.id;
  orgB = b!.id;
  const [p] = await t.db.system
    .insert(s.projects)
    .values({ orgId: orgA, name: "taskboard" })
    .returning();
  projectId = p!.id;
});
afterAll(async () => t?.stop());

async function scanRun(treeHash: string) {
  return t.db.withOrg(orgA, async (tx) => {
    const snap = await createSnapshot(tx, {
      orgId: orgA,
      projectId,
      kind: "zip",
      storageKey: "snapshots/x.zip",
      sizeBytes: 10,
    });
    await updateSnapshot(tx, snap.id, { treeHash, fileCount: 3 });
    const { run } = await createRun(tx, {
      orgId: orgA,
      projectId,
      type: "scan",
      trigger: "manual",
      steps: ["ingest"],
    });
    await tx.update(s.runs).set({ snapshotId: snap.id }).where(sql`${s.runs.id} = ${run.id}`);
    const persisted = await persistRunData(tx, {
      orgId: orgA,
      runId: run.id,
      source: "scan",
      evidence: [
        {
          key: "ev1",
          kind: "route",
          locator: "src/routes/tasks.ts:8",
          payload: { method: "POST", path: "/tasks" },
        },
        {
          key: "ev2",
          kind: "doc_excerpt",
          locator: "README.md:15",
          payload: { text: "Email reminders" },
        },
      ],
      findings: [],
    });
    const { reportId } = await persistScanResult(tx, {
      orgId: orgA,
      runId: run.id,
      snapshotId: snap.id,
      evidenceIds: persisted.evidenceIds,
      graph: {
        nodes: [
          {
            key: "file:src/routes/tasks.ts",
            kind: "file",
            path: "src/routes/tasks.ts",
            name: "src/routes/tasks.ts",
            line: null,
            meta: {},
          },
          {
            key: "api_handler:POST /tasks@src/routes/tasks.ts:8",
            kind: "api_handler",
            path: "src/routes/tasks.ts",
            name: "POST /tasks",
            line: 8,
            meta: { method: "POST" },
          },
        ],
        edges: [
          {
            from: "file:src/routes/tasks.ts",
            to: "api_handler:POST /tasks@src/routes/tasks.ts:8",
            kind: "defines_route",
            weight: 1,
          },
        ],
      },
      features: [
        {
          name: "Create tasks",
          status: "complete",
          reason: "route with no markers",
          evidenceKeys: ["ev1"],
        },
        { name: "Email reminders", status: "planned", reason: "docs only", evidenceKeys: ["ev2"] },
      ],
      claims: [
        {
          section: "features",
          text: "Create tasks is complete.",
          evidenceKeys: ["ev1"],
          verified: true,
          dropReason: null,
          dropDetail: null,
        },
        {
          section: "features",
          text: "Email reminders are implemented.",
          evidenceKeys: ["ev2"],
          verified: false,
          dropReason: "status_contradiction",
          dropDetail: "planned",
        },
      ],
      report: {
        healthScore: 80,
        healthBreakdown: { components: [] },
        coverage: { gaps: [] },
        summary: { languages: { TypeScript: 3 } },
        model: "test",
        usage: [],
      },
    });
    await tx
      .update(s.runs)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(sql`${s.runs.id} = ${run.id}`);
    return { runId: run.id, snapshotId: snap.id, reportId, evidenceIds: persisted.evidenceIds };
  });
}

describe("scan persistence", () => {
  it("stores the graph, features, report and claims, with verified claims in sections", async () => {
    const r = await scanRun("hash-1");
    const view = await t.db.withOrg(orgA, (tx) => getReport(tx, r.runId));
    expect(view?.report.healthScore).toBe(80);
    expect(view?.report.claimsTotal).toBe(2);
    expect(view?.report.claimsDropped).toBe(1);
    expect(view?.report.sections).toEqual({
      features: [{ text: "Create tasks is complete.", evidence_ids: [r.evidenceIds.get("ev1")] }],
    });
    expect(view?.claims.map((c) => `${c.verified}:${c.dropReason}`)).toEqual([
      "true:null",
      "false:status_contradiction",
    ]);
    expect(view?.features.map((f) => `${f.name}:${f.status}`)).toEqual([
      "Create tasks:complete",
      "Email reminders:planned",
    ]);
    const edges = await t.db.withOrg(orgA, (tx) => tx.select().from(s.codeEdges));
    expect(edges.length).toBeGreaterThan(0);
  });

  it("finds a finished scan of an identical tree for reuse", async () => {
    const first = await scanRun("hash-2");
    const other = await t.db.withOrg(orgA, async (tx) => {
      const { run } = await createRun(tx, {
        orgId: orgA,
        projectId,
        type: "scan",
        trigger: "manual",
        steps: ["ingest"],
      });
      return run.id;
    });
    const hit = await t.db.withOrg(orgA, (tx) =>
      findReusableScan(tx, { projectId, treeHash: "hash-2", excludeRunId: other }),
    );
    expect(hit?.runId).toBe(first.runId);
    expect(
      await t.db.withOrg(orgA, (tx) =>
        findReusableScan(tx, { projectId, treeHash: "nope", excludeRunId: other }),
      ),
    ).toBeNull();
  });

  it("serves a cached run's report from the run it reused", async () => {
    const first = await scanRun("hash-3");
    const cachedRun = await t.db.withOrg(orgA, async (tx) => {
      const { run } = await createRun(tx, {
        orgId: orgA,
        projectId,
        type: "scan",
        trigger: "manual",
        steps: ["ingest"],
      });
      await tx
        .update(s.runs)
        .set({ parentRunId: first.runId, outcome: { cached: true } })
        .where(sql`${s.runs.id} = ${run.id}`);
      return run.id;
    });
    const view = await t.db.withOrg(orgA, (tx) => getReport(tx, cachedRun));
    expect(view?.sourceRunId).toBe(first.runId);
    expect(view?.report.healthScore).toBe(80);
  });

  it("isolates every Scan table by org (RLS)", async () => {
    await scanRun("hash-4");
    for (const table of [s.snapshots, s.codeNodes, s.codeEdges, s.features, s.reports, s.claims]) {
      const mine = await t.db.withOrg(orgA, (tx) => tx.select().from(table));
      const theirs = await t.db.withOrg(orgB, (tx) => tx.select().from(table));
      expect(mine.length).toBeGreaterThan(0);
      expect(theirs).toEqual([]);
    }
  });

  it("refuses a dropped claim without a reason", async () => {
    const r = await scanRun("hash-5");
    await expect(
      t.db.withOrg(orgA, (tx) =>
        tx.insert(s.claims).values({
          orgId: orgA,
          reportId: r.reportId,
          position: 9,
          section: "x",
          text: "x",
          evidenceIds: [],
          verified: false,
        }),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/claims_dropped_has_reason/),
      }),
    });
  });
});
