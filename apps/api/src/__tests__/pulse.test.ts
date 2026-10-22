import { launchPulseBrowser } from "@codesentra/checks";
import { pulseHandler } from "@codesentra/checks/job";
import { type Harness, startHarness } from "@codesentra/fixture-harness";
import { testPolicy } from "@codesentra/ssrf";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, signIn, startTestApi, type TestApi } from "./helpers.js";

let api: TestApi;
let h: Harness;
let browser: Browser;
let cookie: string;
let orgId: string;

beforeAll(async () => {
  h = await startHarness();
  const launched = await launchPulseBrowser();
  if (!launched.browser) throw new Error(launched.reason);
  browser = launched.browser;
  api = await startTestApi({
    env: { PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
    handlers: {
      "pulse.run": pulseHandler({
        policy: testPolicy(["127.0.0.1"], { ca: h.caCertPem }),
        store: null,
        getBrowser: async () => ({ browser }),
        slowThresholdMs: 3000,
      }),
    },
  });
  cookie = await signIn(api, "pulse@example.com");
  orgId = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json()
    .organizations[0].id;
}, 180_000);

afterAll(async () => {
  await api?.close();
  await browser?.close();
  await h?.close();
});

async function waitForRun(runId: string) {
  for (let i = 0; i < 150; i++) {
    const run = (
      await api.app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie } })
    ).json();
    if (["succeeded", "failed", "partial"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("run did not finish");
}

async function projectFor(app: string) {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: as(cookie),
    payload: {
      org_id: orgId,
      name: app,
      environments: [{ name: "production", url: h.targets.apps[app]?.url }],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; environments: { id: string }[] };
}

async function pulse(projectId: string, envId: string) {
  const res = await api.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/pulse`,
    headers: as(cookie),
    payload: { environment_id: envId },
  });
  expect(res.statusCode, res.body).toBe(202);
  return waitForRun(res.json().run_id);
}

describe("project Pulse end to end", () => {
  it("env-undefined: one merged issue with a prompt, then resolves when fixed and regresses when broken again", async () => {
    const p = await projectFor("env-undefined");
    const envId = p.environments[0]!.id;

    const run1 = await pulse(p.id, envId);
    expect(run1.status).toBe("succeeded");
    expect(run1.outcome.pulse_status).toBe("degraded");
    expect(
      run1.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`),
    ).toEqual([
      "reachability:done",
      "platform:done",
      "render:done",
      "routes:done",
      "hygiene:done",
      "issues:done",
    ]);

    const issues = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/issues`,
        headers: { cookie },
      })
    ).json();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "UNDEFINED_IN_URL",
      status: "open",
      corroborating_codes: ["SAME_ORIGIN_FAILURE"],
    });

    const detail = (
      await api.app.inject({
        method: "GET",
        url: `/v1/issues/${issues[0].id}`,
        headers: { cookie },
      })
    ).json();
    expect(detail.prompt.type).toBe("investigate");
    expect(detail.prompt.body).toContain("/api/ping");
    expect(detail.observed.map((f: { code: string }) => f.code).sort()).toEqual([
      "SAME_ORIGIN_FAILURE",
      "UNDEFINED_IN_URL",
    ]);
    const ev = await api.app.inject({
      method: "GET",
      url: `/v1/evidence/${detail.observed[0].evidence.id}`,
      headers: { cookie },
    });
    expect(ev.statusCode).toBe(200);
    expect(ev.json().kind).toBe("browser_request");

    const project = (
      await api.app.inject({ method: "GET", url: `/v1/projects/${p.id}`, headers: { cookie } })
    ).json();
    expect(project.environments[0].status.pulse_status).toBe("degraded");
    expect(project.open_issues).toBe(1);

    h.setVariant("env-undefined", "fixed");
    try {
      const run2 = await pulse(p.id, envId);
      expect(run2.outcome.pulse_status).toBe("live");
      const after = (
        await api.app.inject({
          method: "GET",
          url: `/v1/issues/${issues[0].id}`,
          headers: { cookie },
        })
      ).json();
      expect(after.status).toBe("resolved");
      expect(after.resolved_run_id).toBe(run2.id);
    } finally {
      h.setVariant("env-undefined", "broken");
    }
    await pulse(p.id, envId);
    const regressed = (
      await api.app.inject({
        method: "GET",
        url: `/v1/issues/${issues[0].id}`,
        headers: { cookie },
      })
    ).json();
    expect(regressed.status).toBe("regressed");
    expect(regressed.events.map((e: { kind: string }) => e.kind)).toEqual([
      "opened",
      "resolved",
      "regressed",
    ]);
  });

  it("healthy: live with zero issues", async () => {
    const p = await projectFor("healthy");
    const run = await pulse(p.id, p.environments[0]!.id);
    expect(run.outcome.pulse_status).toBe("live");
    expect(run.outcome.gaps).toEqual([]);
    const issues = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/issues`,
        headers: { cookie },
      })
    ).json();
    expect(issues).toEqual([]);
  });

  it("dismisses with a reason, audited", async () => {
    const p = await projectFor("blank");
    await pulse(p.id, p.environments[0]!.id);
    const [issue] = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/issues`,
        headers: { cookie },
      })
    ).json();
    const res = await api.app.inject({
      method: "POST",
      url: `/v1/issues/${issue.id}/dismiss`,
      headers: as(cookie),
      payload: { reason: "intentional splash page" },
    });
    expect(res.json()).toMatchObject({
      status: "dismissed",
      dismissed_reason: "intentional splash page",
    });
    const filtered = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/issues?status=open,regressed`,
        headers: { cookie },
      })
    ).json();
    expect(filtered).toEqual([]);
    const bad = await api.app.inject({
      method: "GET",
      url: `/v1/projects/${p.id}/issues?status=bogus`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Quick Pulse", () => {
  it("checks a URL without a project and returns findings grouped into prompts", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/pulse",
      headers: as(cookie),
      payload: { url: h.targets.apps["console-throw"]?.url, org_id: orgId },
    });
    expect(res.statusCode, res.body).toBe(202);
    const run = await waitForRun(res.json().run_id);
    expect(run.outcome.pulse_status).toBe("degraded");
    expect(run.steps.map((s: { name: string }) => s.name)).not.toContain("issues");
    const f = (
      await api.app.inject({
        method: "GET",
        url: `/v1/runs/${run.id}/findings`,
        headers: { cookie },
      })
    ).json();
    expect(f.findings.map((x: { code: string }) => x.code)).toEqual(["UNCAUGHT_EXCEPTION"]);
    expect(f.issues).toHaveLength(1);
    expect(f.issues[0]).toMatchObject({ issue_id: null, code: "UNCAUGHT_EXCEPTION" });
    expect(f.issues[0].prompt.body).toContain("CS_FIXTURE_BOOM");
  });

  it("refuses private targets up front", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:8080/",
      "http://10.0.0.1/",
      "http://[::1]/",
    ]) {
      const res = await api.app.inject({
        method: "POST",
        url: "/v1/pulse",
        headers: as(cookie),
        payload: { url, org_id: orgId },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("requires membership of the org it runs under", async () => {
    const other = await signIn(api, "pulse-other@example.com");
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/pulse",
      headers: as(other),
      payload: { url: "https://example.com/", org_id: orgId },
    });
    expect(res.statusCode).toBe(404);
  });
});
