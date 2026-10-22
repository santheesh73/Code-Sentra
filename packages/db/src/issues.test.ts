import { recheckFor } from "@codesentra/core";
import { fingerprint } from "@codesentra/core/hashing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEvidence, listRunFindings, persistRunData } from "./queries/findings.js";
import {
  dismissIssue,
  getFixPrompt,
  getIssueDetail,
  type IssueDraft,
  listIssues,
  syncIssues,
} from "./queries/issues.js";
import { createRun } from "./queries/runs.js";
import * as s from "./schema.js";
import { startTestDatabase, type TestDatabase } from "./testing.js";

let t: TestDatabase;
let orgA: string;
let orgB: string;
let projectId: string;
let envId: string;
const URL_ = "https://shop.example.com/undefined/api/ping";
const FP = fingerprint("UNDEFINED_IN_URL", "pulse", URL_);

beforeAll(async () => {
  t = await startTestDatabase();
  const [a, b] = await t.db.system
    .insert(s.organizations)
    .values([
      { name: "A", slug: "ia" },
      { name: "B", slug: "ib" },
    ])
    .returning();
  orgA = a!.id;
  orgB = b!.id;
  const [p] = await t.db.system
    .insert(s.projects)
    .values({ orgId: orgA, name: "shop" })
    .returning();
  projectId = p!.id;
  const [e] = await t.db.system
    .insert(s.environments)
    .values({ orgId: orgA, projectId, name: "production", url: "https://shop.example.com/" })
    .returning();
  envId = e!.id;
});
afterAll(async () => t?.stop());

/** Simulates one Pulse run: persists evidence/findings, then syncs issues. */
async function pulseRun(opts: { observed: boolean; ranGroups?: string[]; promptBody?: string }) {
  return t.db.withOrg(orgA, async (tx) => {
    const { run } = await createRun(tx, {
      orgId: orgA,
      projectId,
      environmentId: envId,
      type: "pulse",
      trigger: "manual",
      steps: ["render"],
    });
    const persisted = await persistRunData(tx, {
      orgId: orgA,
      runId: run.id,
      source: "pulse",
      evidence: opts.observed
        ? [
            {
              key: "e1",
              kind: "browser_request",
              locator: URL_,
              payload: { url: URL_, status: 404 },
            },
          ]
        : [
            {
              key: "e1",
              kind: "render_summary",
              locator: "https://shop.example.com/",
              payload: { text_length: 40 },
            },
          ],
      findings: opts.observed
        ? [
            {
              code: "UNDEFINED_IN_URL",
              severity: "error",
              evidenceKey: "e1",
              locator: URL_,
              message: "undefined in URL",
              fingerprint: FP,
            },
          ]
        : [],
    });
    const drafts: IssueDraft[] = opts.observed
      ? [
          {
            fingerprint: FP,
            code: "UNDEFINED_IN_URL",
            severity: "error",
            title: "Request URL contains an undefined value",
            locator: URL_,
            summary: "undefined in URL",
            corroboratingCodes: ["SAME_ORIGIN_FAILURE"],
            findingIds: persisted.findingIds,
            recheck: recheckFor("UNDEFINED_IN_URL", URL_, "https://shop.example.com/"),
            prompt: {
              type: "investigate",
              body: opts.promptBody ?? "prompt v1",
              templateVersion: "investigate@1",
            },
          },
        ]
      : [];
    const r = await syncIssues(tx, {
      orgId: orgA,
      projectId,
      environmentId: envId,
      runId: run.id,
      module: "pulse",
      ranGroups: opts.ranGroups ?? ["reachability", "platform", "render", "routes", "hygiene"],
      drafts,
    });
    return { runId: run.id, r };
  });
}

const status = async () =>
  (await t.db.withOrg(orgA, (tx) => listIssues(tx, projectId))).map((i) => `${i.code}:${i.status}`);

describe("issue lifecycle (Section 10d)", () => {
  it("opens an issue with a prompt on first sight, and links evidence", async () => {
    const { r, runId } = await pulseRun({ observed: true });
    expect(r.opened).toHaveLength(1);
    expect(await status()).toEqual(["UNDEFINED_IN_URL:open"]);
    const detail = await t.db.withOrg(orgA, (tx) => getIssueDetail(tx, r.opened[0]!));
    expect(detail?.prompt?.version).toBe(1);
    expect(detail?.issue.corroboratingCodes).toEqual(["SAME_ORIGIN_FAILURE"]);
    expect(detail?.observed[0]?.evidence.payload).toEqual({ url: URL_, status: 404 });
    const findings = await t.db.withOrg(orgA, (tx) => listRunFindings(tx, runId));
    expect(findings[0]?.finding.fingerprint).toBe(FP);
    const ev = await t.db.withOrg(orgA, (tx) => getEvidence(tx, findings[0]!.evidence.id));
    expect(ev?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a sighting, not a duplicate, and versions a changed prompt", async () => {
    const { r } = await pulseRun({ observed: true, promptBody: "prompt v2" });
    expect(r.seen).toHaveLength(1);
    expect(await status()).toEqual(["UNDEFINED_IN_URL:open"]);
    const prompt = await t.db.withOrg(orgA, (tx) => getFixPrompt(tx, r.seen[0]!));
    expect(prompt?.version).toBe(2);
    const v1 = await t.db.withOrg(orgA, (tx) => getFixPrompt(tx, r.seen[0]!, 1));
    expect(v1?.body).toBe("prompt v1");
  });

  it("never resolves when the re-check's group was skipped", async () => {
    const { r } = await pulseRun({ observed: false, ranGroups: ["reachability", "platform"] });
    expect(r.resolved).toEqual([]);
    expect(await status()).toEqual(["UNDEFINED_IN_URL:open"]);
  });

  it("resolves when the group ran and the problem is gone, then regresses when it returns", async () => {
    const resolved = await pulseRun({ observed: false });
    expect(resolved.r.resolved).toHaveLength(1);
    expect(await status()).toEqual(["UNDEFINED_IN_URL:resolved"]);
    const [row] = await t.db.system.select().from(s.issues).where(eq(s.issues.fingerprint, FP));
    expect(row?.resolvedRunId).toBe(resolved.runId);

    const back = await pulseRun({ observed: true, promptBody: "prompt v2" });
    expect(back.r.regressed).toHaveLength(1);
    expect(await status()).toEqual(["UNDEFINED_IN_URL:regressed"]);

    const detail = await t.db.withOrg(orgA, (tx) => getIssueDetail(tx, back.r.regressed[0]!));
    expect(detail?.events.map((e) => e.kind)).toEqual(["opened", "seen", "resolved", "regressed"]);
  });

  it("keeps dismissed issues dismissed", async () => {
    const id = (await t.db.withOrg(orgA, (tx) => listIssues(tx, projectId)))[0]!.id;
    const [user] = await t.db.system
      .insert(s.users)
      .values({ email: "dismisser@example.com" })
      .returning();
    const row = await t.db.withOrg(orgA, (tx) =>
      dismissIssue(tx, {
        orgId: orgA,
        issueId: id,
        actorId: user!.id,
        reason: "known false positive",
      }),
    );
    expect(row?.status).toBe("dismissed");
    await pulseRun({ observed: true });
    await pulseRun({ observed: false });
    expect(await status()).toEqual(["UNDEFINED_IN_URL:dismissed"]);
    const detail = await t.db.withOrg(orgA, (tx) => getIssueDetail(tx, id));
    const dismissed = detail?.events.find((e) => e.kind === "dismissed");
    expect(dismissed?.actorId).toBe(user!.id);
    expect(dismissed?.note).toBe("known false positive");
  });

  it("isolates Phase 2 tables by org", async () => {
    expect(await t.db.withOrg(orgB, (tx) => tx.select().from(s.issues))).toEqual([]);
    expect(await t.db.withOrg(orgB, (tx) => tx.select().from(s.evidence))).toEqual([]);
    expect(await t.db.withOrg(orgB, (tx) => tx.select().from(s.findings))).toEqual([]);
    expect(await t.db.withOrg(orgB, (tx) => tx.select().from(s.fixPrompts))).toEqual([]);
    expect(await t.db.withOrg(orgB, (tx) => tx.select().from(s.issueEvents))).toEqual([]);
    await expect(t.db.withOrg(orgA, (tx) => tx.delete(s.issueEvents))).rejects.toThrow();
  });
});
