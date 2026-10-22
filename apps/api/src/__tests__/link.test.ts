import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { launchPulseBrowser } from "@codesentra/checks";
import { pulseHandler } from "@codesentra/checks/job";
import {
  FIXTURE_REPOS_DIR,
  type Harness,
  loadFixtureApps,
  startHarness,
} from "@codesentra/fixture-harness";
import { linkHandler } from "@codesentra/link/job";
import { offlineSource } from "@codesentra/scan";
import { scanHandler } from "@codesentra/scan/job";
import { testPolicy } from "@codesentra/ssrf";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { as, memoryStore, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Phase 4 gate at the API: a full check on env-undefined (a real Scan of the fixture's
 * source, real Pulse in Chromium, then Link) produces one merged issue whose code_fix
 * prompt names NEXT_PUBLIC_API_URL and app/page.tsx:9; serving the fixed build resolves
 * it with no manual action, and re-breaking it regresses it.
 */
let api: TestApi;
let h: Harness;
let browser: Browser;
let cookie: string;
let orgId: string;
const store = memoryStore();
const app = loadFixtureApps().find((a) => a.manifest.name === "env-undefined");

async function sourceZip(dir: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (["node_modules", ".next", ".turbo", "out", "out-fixed"].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else zip.addFile(p, relative(dir, p));
    }
  };
  walk(dir);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  if (!app) throw new Error("env-undefined fixture missing");
  h = await startHarness();
  const launched = await launchPulseBrowser();
  if (!launched.browser) throw new Error(launched.reason);
  browser = launched.browser;
  const osv = await offlineSource(join(FIXTURE_REPOS_DIR, "../osv"));
  api = await startTestApi({
    store,
    env: { PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
    handlers: {
      "pulse.run": pulseHandler({
        policy: testPolicy(["127.0.0.1"], { ca: h.caCertPem }),
        store: null,
        getBrowser: async () => ({ browser }),
        slowThresholdMs: 3000,
      }),
      "issue.recheck": pulseHandler({
        policy: testPolicy(["127.0.0.1"], { ca: h.caCertPem }),
        store: null,
        getBrowser: async () => ({ browser }),
        slowThresholdMs: 3000,
      }),
      "scan.run": scanHandler({
        store,
        sandbox: async () => ({ sandbox: null, reason: "no sandbox in API tests" }),
        osv: { source: osv },
        secrets: { enabled: false, reason: "gitleaks not run in API tests" },
        model: { model: null, reason: "no report model in API tests" },
        gitPolicy: testPolicy(["127.0.0.1"]),
        allowHttpGit: true,
        maxCommits: 100,
      }),
      "link.run": linkHandler(),
    },
  });
  cookie = await signIn(api, "link@example.com");
  orgId = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json()
    .organizations[0].id;
}, 180_000);

afterAll(async () => {
  await api?.close();
  await browser?.close();
  await h?.close();
});

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

const get = async (url: string) =>
  (await api.app.inject({ method: "GET", url, headers: { cookie } })).json();

describe("Phase 4 gate (API): full check, trace, prompt, resolve, regress", () => {
  it("env-undefined end to end", async () => {
    const created = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: as(cookie),
      payload: {
        org_id: orgId,
        name: "status-board",
        environments: [{ name: "production", url: h.targets.apps["env-undefined"]?.url }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const project = created.json();
    const envId = project.environments[0].id;
    const up = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/snapshots`,
      headers: { ...as(cookie), "content-type": "application/zip" },
      payload: await sourceZip(app?.dir as string),
    });
    expect(up.statusCode, up.body).toBe(201);

    // Full check: Scan + Pulse in parallel, then Link.
    const check = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/check`,
      headers: as(cookie),
      payload: {},
    });
    expect(check.statusCode, check.body).toBe(202);
    const link = await waitForRun(check.json().run_id);
    expect(link.type).toBe("link");
    expect(link.children.map((c: { type: string }) => c.type).sort()).toEqual(["pulse", "scan"]);
    expect(
      link.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`),
    ).toEqual(["trace:done", "widen:done", "prompt:done", "verify:done"]);

    const pulseIssues = (await get(`/v1/projects/${project.id}/issues?source=pulse`)) as {
      id: string;
      code: string;
      corroborating_codes: string[];
    }[];
    expect(pulseIssues, JSON.stringify(pulseIssues).slice(0, 500)).toHaveLength(1);
    expect(pulseIssues[0]).toMatchObject({
      code: "UNDEFINED_IN_URL",
      corroborating_codes: ["SAME_ORIGIN_FAILURE"],
    });
    const issueId = pulseIssues[0]?.id as string;
    const detail = await get(`/v1/issues/${issueId}`);
    expect(detail.prompt.type).toBe("code_fix");
    expect(detail.prompt.body).toContain("NEXT_PUBLIC_API_URL");
    expect(detail.prompt.body).toContain("app/page.tsx:9");
    expect(detail.prompt.body).toContain("Investigate and confirm the cause before editing");
    expect(detail.traces).toEqual([
      expect.objectContaining({
        path: "app/page.tsx",
        line: 9,
        join_key: "/api/ping",
        env_vars: [{ name: "NEXT_PUBLIC_API_URL", documented: false }],
        run_id: link.id,
      }),
    ]);
    expect(detail.traces[0].excerpt).toContain("process.env.NEXT_PUBLIC_API_URL}/api/ping");

    // Scan issues are stored too, with code_fix prompts at their file and line.
    const scanIssues = (await get(`/v1/projects/${project.id}/issues?source=scan`)) as {
      code: string;
      locator: string;
    }[];
    expect(scanIssues).toContainEqual(
      expect.objectContaining({ code: "ENV_VAR_UNDOCUMENTED", locator: "app/page.tsx:9" }),
    );

    // The fix is deployed: the next Pulse (and its Link run) resolves the issue by itself.
    h.setVariant("env-undefined", "fixed");
    try {
      const res = await api.app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/pulse`,
        headers: as(cookie),
        payload: { environment_id: envId },
      });
      const pulseRun = await waitForRun(res.json().run_id);
      expect(pulseRun.outcome.pulse_status).toBe("live");
      await waitForRun(res.json().link_run_id);
      const after = await get(`/v1/issues/${issueId}`);
      expect(after.status).toBe("resolved");
      expect(after.resolved_run_id).toBe(pulseRun.id);
    } finally {
      h.setVariant("env-undefined", "broken");
    }

    // Broken again: a targeted re-check of the render group regresses it.
    const re = await api.app.inject({
      method: "POST",
      url: `/v1/issues/${issueId}/recheck`,
      headers: as(cookie),
    });
    expect(re.statusCode, re.body).toBe(202);
    const reLink = await waitForRun(re.json().run_id);
    const reRun = reLink.children[0];
    expect(reRun).toMatchObject({ type: "recheck", parent_run_id: reLink.id });
    const reDetail = await waitForRun(reRun.id);
    expect(
      reDetail.steps
        .filter((s: { status: string }) => s.status === "done")
        .map((s: { name: string }) => s.name),
    ).toEqual(["reachability", "platform", "render"]);
    const regressed = await get(`/v1/issues/${issueId}`);
    expect(regressed.status).toBe("regressed");
    expect(regressed.events.map((e: { kind: string }) => e.kind)).toEqual([
      "opened",
      "resolved",
      "regressed",
    ]);
    // The environment's badge reflects full Pulse runs only, never a targeted re-check.
    const p = await get(`/v1/projects/${project.id}`);
    expect(p.environments[0].status.pulse_status).toBe("live");
  }, 600_000);

  it("refuses a full check with nothing to check, and a re-check of a dismissed issue", async () => {
    const created = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: as(cookie),
      payload: { org_id: orgId, name: "empty" },
    });
    const res = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${created.json().id}/check`,
      headers: as(cookie),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
