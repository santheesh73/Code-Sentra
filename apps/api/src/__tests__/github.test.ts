import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { launchPulseBrowser, PULSE_GROUPS } from "@codesentra/checks";
import { pulseHandler } from "@codesentra/checks/job";
import { ScanStage } from "@codesentra/core";
import { schema as s } from "@codesentra/db";
import {
  type FakeGithubApp,
  FIXTURE_REPOS_DIR,
  type Harness,
  loadFixtureApps,
  startFakeGithubApp,
  startHarness,
} from "@codesentra/fixture-harness";
import { GithubApp } from "@codesentra/github";
import { linkHandler } from "@codesentra/link/job";
import { runDueSchedules } from "@codesentra/queue";
import { offlineSource } from "@codesentra/scan";
import { scanHandler } from "@codesentra/scan/job";
import { testPolicy } from "@codesentra/ssrf";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, memoryStore, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Phase 5 gate at the API (Section 18), against a local fake of the GitHub API: a pull
 * request that introduces the env-undefined bug gets a failing "CodeSentra" check run
 * whose text carries the code_fix prompt; a follow-up commit that fixes it turns that
 * commit's check green. The project's own issues are never touched by a branch.
 */
let api: TestApi;
let gh: FakeGithubApp;
let h: Harness;
let browser: Browser;
let cookie: string;
let orgId: string;
const store = memoryStore();
const REPO = "acme/status-board";
const INSTALLATION = 7001;
// Real commits in the fake's git server (set in beforeAll): PR scans clone them with history.
let shaA: string;
let shaB: string;
let shaC: string;
const app = loadFixtureApps().find((a) => a.manifest.name === "env-undefined");

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (["node_modules", ".next", ".turbo", "out", "out-fixed"].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  if (!app) throw new Error("env-undefined fixture missing");
  h = await startHarness();
  gh = await startFakeGithubApp();
  const launched = await launchPulseBrowser();
  if (!launched.browser) throw new Error(launched.reason);
  browser = launched.browser;
  const osv = await offlineSource(join(FIXTURE_REPOS_DIR, "../osv"));
  const github = new GithubApp({
    appId: gh.appId,
    privateKey: gh.privateKeyPem,
    apiBaseUrl: gh.url,
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    oauthBaseUrl: gh.url,
    gitBaseUrl: gh.gitBaseUrl,
  });
  const pulse = pulseHandler({
    policy: testPolicy(["127.0.0.1"], { ca: h.caCertPem }),
    store: null,
    getBrowser: async () => ({ browser }),
    slowThresholdMs: 3000,
  });
  const scan = scanHandler({
    store,
    sandbox: async () => ({ sandbox: null, reason: "no sandbox in API tests" }),
    osv: { source: osv },
    secrets: { enabled: false, reason: "gitleaks not run in API tests" },
    model: { model: null, reason: "no report model in API tests" },
    gitPolicy: testPolicy(["127.0.0.1"]),
    allowHttpGit: true,
    maxCommits: 100,
    github,
  });
  api = await startTestApi({
    store,
    githubApp: github,
    env: {
      PULSE_TEST_ALLOW_HOSTS: "127.0.0.1",
      GITHUB_APP_ID: gh.appId,
      GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
      GITHUB_WEBHOOK_SECRET: gh.webhookSecret,
      GITHUB_APP_CLIENT_ID: gh.clientId,
      GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
      GITHUB_APP_SLUG: "codesentra-test",
    },
    handlers: {
      "pulse.run": pulse,
      "scan.incremental": scan,
      "scan.run": scan,
      "link.run": linkHandler({ github, appUrl: "http://localhost:3000" }),
    },
  });
  cookie = await signIn(api, "github@example.com");
  orgId = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json()
    .organizations[0].id;

  // Base: the page without the API call. B introduces the bug; C documents and sets the
  // variable (the fixed build).
  const head = tree(app.dir);
  const page = head["app/page.tsx"] as string;
  shaA = gh.gitCommit(REPO, {
    ...head,
    "app/page.tsx": page.replace(/\n {2}useEffect\([\s\S]*?\}, \[\]\);\n/, "\n"),
  });
  shaB = gh.gitCommit(REPO, head, "call the API");
  shaC = gh.gitCommit(REPO, { ...head, ".env.example": "NEXT_PUBLIC_API_URL=\n" }, "document it");
}, 180_000);

afterAll(async () => {
  await api?.close();
  await browser?.close();
  await gh?.close();
  await h?.close();
});

function deliver(event: string, payload: unknown, opts: { id?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", opts.secret ?? gh.webhookSecret)
    .update(body)
    .digest("hex");
  return api.app.inject({
    method: "POST",
    url: "/v1/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.id ?? randomUUID(),
      "x-hub-signature-256": `sha256=${sig}`,
    },
    payload: body,
  });
}

async function waitForRun(runId: string) {
  for (let i = 0; i < 600; i++) {
    const run = (
      await api.app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie } })
    ).json();
    if (["succeeded", "failed", "partial"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} did not finish`);
}

const linkRunOf = (res: { json: () => { detail: string } }) =>
  /link runs ([0-9a-f-]{36})/.exec(res.json().detail)?.[1] as string;

const repository = { full_name: REPO, default_branch: "main" };
const installation = { id: INSTALLATION };
const pr = (action: string, head: string, base: string) => ({
  action,
  number: 12,
  pull_request: { head: { sha: head, ref: "feature" }, base: { sha: base, ref: "main" } },
  repository,
  installation,
});
const deployment = (sha: string, url: string) => ({
  deployment_status: { state: "success", target_url: url, environment_url: url },
  deployment: { sha, environment: "Preview" },
  repository,
  installation,
});

describe("GitHub App (Phase 5)", () => {
  let projectId: string;

  it("rejects bad signatures and links an installation only with proof of access", async () => {
    const forged = await deliver("ping", { zen: "hi" }, { secret: "not-the-secret-at-all" });
    expect(forged.statusCode).toBe(401);

    const installed = await deliver("installation", {
      action: "created",
      installation: { id: INSTALLATION, account: { login: "acme" } },
      repositories: [{ full_name: REPO }],
    });
    expect(installed.json()).toMatchObject({ status: "processed" });

    const start = await api.app.inject({
      method: "GET",
      url: `/v1/github/install?org_id=${orgId}`,
      headers: { cookie },
    });
    expect(start.statusCode, start.body).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;
    expect(start.headers.location).toContain("/apps/codesentra-test/installations/new");

    // A code whose user cannot see the installation is refused (installation_id is untrusted).
    gh.authorize("code-other", [999]);
    const refused = await api.app.inject({
      method: "GET",
      url: `/v1/github/setup?installation_id=${INSTALLATION}&state=${encodeURIComponent(state)}&code=code-other`,
      headers: { cookie },
    });
    expect(refused.statusCode).toBe(400);

    gh.authorize("code-ok", [INSTALLATION]);
    const linked = await api.app.inject({
      method: "GET",
      url: `/v1/github/setup?installation_id=${INSTALLATION}&state=${encodeURIComponent(state)}&code=code-ok`,
      headers: { cookie },
    });
    expect(linked.statusCode, linked.body).toBe(302);
    const list = await api.app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/github/installations`,
      headers: { cookie },
    });
    expect(list.json().installations).toEqual([
      { installation_id: INSTALLATION, account: "acme", repositories: [REPO], suspended: false },
    ]);
    // A later event without a repository list (suspend/unsuspend) keeps the list.
    for (const action of ["suspend", "unsuspend"])
      await deliver("installation", {
        action,
        installation: { id: INSTALLATION, account: { login: "acme" } },
      });
    const after = await api.app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/github/installations`,
      headers: { cookie },
    });
    expect(after.json().installations[0]).toMatchObject({
      repositories: [REPO],
      suspended: false,
    });
    // Installation data is sealed at rest.
    const [row] = await api.t.db.system.select().from(s.githubInstallations);
    expect(row?.sealed).toMatch(/^v2\./);
    expect(row?.sealed).not.toContain("acme");
  });

  it("a PR that introduces env-undefined fails its check; the fix commit turns it green", async () => {
    const created = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: as(cookie),
      payload: { org_id: orgId, name: "status-board" },
    });
    projectId = created.json().id;
    const bound = await api.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: as(cookie),
      payload: { github_repo: REPO },
    });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().github_repo).toBe(REPO);

    // pull_request.opened → incremental Scan of B → Link (PR mode) → check run.
    const id = randomUUID();
    const opened = await deliver("pull_request", pr("opened", shaB, shaA), { id });
    expect(opened.statusCode, opened.body).toBe(200);
    const prLink = await waitForRun(linkRunOf(opened));
    // The head commit was cloned with its history (not the zipball): history ran.
    const prScan = prLink.children.find((k: { type: string }) => k.type === "scan");
    const scanRun = await (
      await api.app.inject({ method: "GET", url: `/v1/runs/${prScan.id}`, headers: { cookie } })
    ).json();
    expect(
      scanRun.steps.find((x: { name: string }) => x.name === "history")?.status,
      JSON.stringify(scanRun.steps),
    ).toBe("done");
    const [row] = await api.t.db.system
      .select({ snap: s.snapshots })
      .from(s.runs)
      .innerJoin(s.snapshots, eq(s.snapshots.id, s.runs.snapshotId))
      .where(eq(s.runs.id, prScan.id));
    expect(row?.snap).toMatchObject({ kind: "github", hasHistory: true, commitSha: shaB });
    expect(prLink.outcome).toMatchObject({ mode: "pr", changed_files: ["app/page.tsx"] });
    const dup = await deliver("pull_request", pr("opened", shaB, shaA), { id });
    expect(dup.json()).toMatchObject({ status: "duplicate" });

    // The preview deployment of B: Pulse finds /undefined/api/ping, traced into the PR.
    h.setVariant("env-undefined", "broken");
    const deployedB = await deliver(
      "deployment_status",
      deployment(shaB, h.targets.apps["env-undefined"]?.url as string),
    );
    await waitForRun(linkRunOf(deployedB));
    const checkB = gh.checkRuns.filter((c) => c.head_sha === shaB);
    expect(checkB).toHaveLength(1);
    expect(checkB[0]).toMatchObject({
      name: "CodeSentra",
      status: "completed",
      conclusion: "failure",
    });
    expect(checkB[0]?.output?.title).toContain("Degraded");
    expect(checkB[0]?.output?.text).toContain("UNDEFINED_IN_URL");
    expect(checkB[0]?.output?.text).toContain("NEXT_PUBLIC_API_URL");
    expect(checkB[0]?.output?.text).toContain("app/page.tsx:9");
    expect(checkB[0]?.output?.text).toContain("Fix prompt");

    // The fix: C documents the variable and its preview is built with it set.
    const sync = await deliver("pull_request", pr("synchronize", shaC, shaA));
    await waitForRun(linkRunOf(sync));
    h.setVariant("env-undefined", "fixed");
    try {
      const deployedC = await deliver(
        "deployment_status",
        deployment(shaC, h.targets.apps["env-undefined"]?.url as string),
      );
      await waitForRun(linkRunOf(deployedC));
    } finally {
      h.setVariant("env-undefined", "broken");
    }
    const checkC = gh.checkRuns.filter((c) => c.head_sha === shaC);
    expect(checkC).toHaveLength(1);
    expect(checkC[0], JSON.stringify(checkC[0]?.output)).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    expect(checkC[0]?.output?.title).toContain("Live");

    // A branch never opens or resolves the project's issues.
    const issues = await api.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/issues`,
      headers: { cookie },
    });
    expect(issues.json()).toEqual([]);
  }, 300_000);

  it("full checks and scheduled full checks scan the GitHub repository's head, with history", async () => {
    const env = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments`,
      headers: as(cookie),
      payload: { name: "production", url: h.targets.apps.healthy?.url },
    });
    expect(env.statusCode, env.body).toBe(201);
    const scanOf = async (linkRunId: string) => {
      const link = await waitForRun(linkRunId);
      const scan = link.children.find((k: { type: string }) => k.type === "scan");
      expect(scan, JSON.stringify(link.children)).toBeDefined();
      const [row] = await api.t.db.system
        .select({ snap: s.snapshots })
        .from(s.runs)
        .innerJoin(s.snapshots, eq(s.snapshots.id, s.runs.snapshotId))
        .where(eq(s.runs.id, scan.id));
      const run = await (
        await api.app.inject({ method: "GET", url: `/v1/runs/${scan.id}`, headers: { cookie } })
      ).json();
      return { link, snap: row?.snap, steps: JSON.stringify(run.steps?.[0]) };
    };

    // A full check: no snapshot given, no repo_url, but the App covers the repository.
    const check = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/check`,
      headers: as(cookie),
      payload: {},
    });
    expect(check.statusCode, check.body).toBe(202);
    const full = await scanOf(check.json().run_id);
    expect(full.snap, full.steps).toMatchObject({
      kind: "github",
      commitSha: shaC,
      hasHistory: true,
    });
    expect(full.link.children.map((k: { type: string }) => k.type).sort()).toEqual([
      "pulse",
      "scan",
    ]);

    // A scheduled full check does the same from worker-link's scheduler.
    const sched = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/schedules`,
      headers: as(cookie),
      payload: { environment_id: env.json().id, cron: "0 6 * * *", run_type: "check" },
    });
    expect(sched.statusCode, sched.body).toBe(201);
    expect(sched.json().run_type).toBe("check");
    const fired = await runDueSchedules(
      {
        db: api.t.db,
        queue: api.queue,
        pulseSteps: PULSE_GROUPS,
        scanSteps: ScanStage.options,
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      },
      new Date(Date.now() + 2 * 86_400_000),
    );
    expect(fired.failed).toEqual([]);
    const scheduled = await scanOf(fired.started[0]?.linkRunId as string);
    expect(scheduled.link.trigger).toBe("schedule");
    expect(scheduled.snap).toMatchObject({ kind: "github", ref: "HEAD", commitSha: shaC });
  }, 300_000);

  it("lets a failed delivery be redelivered, but never a processed one", async () => {
    const id = randomUUID();
    const broken = await deliver("pull_request", { action: "opened", number: 1 }, { id });
    expect(broken.statusCode).toBe(400);
    const [row] = await api.t.db.system
      .select()
      .from(s.webhookDeliveries)
      .where(eq(s.webhookDeliveries.deliveryId, id));
    expect(row?.status).toBe("failed");
    const redelivered = await deliver(
      "pull_request",
      { ...pr("opened", shaB, shaA), repository: { full_name: "acme/unbound" } },
      { id },
    );
    expect(redelivered.json()).toMatchObject({ status: "ignored" });
    const again = await deliver("pull_request", pr("opened", shaB, shaA), { id });
    expect(again.json()).toMatchObject({ status: "duplicate" });
    await api.t.db.system.delete(s.webhookDeliveries).where(eq(s.webhookDeliveries.deliveryId, id));
  });

  it("ignores repositories no project is bound to, and other installations", async () => {
    const other = await deliver("pull_request", {
      ...pr("opened", shaB, shaA),
      installation: { id: 999 },
    });
    expect(other.json()).toMatchObject({ status: "ignored" });
    const unbound = await deliver("pull_request", {
      ...pr("opened", shaB, shaA),
      repository: { full_name: "acme/other" },
    });
    expect(unbound.json()).toMatchObject({ status: "ignored" });
    const rows = await api.t.db.system
      .select()
      .from(s.webhookDeliveries)
      .where(eq(s.webhookDeliveries.status, "failed"));
    expect(rows).toEqual([]);
  });
});
