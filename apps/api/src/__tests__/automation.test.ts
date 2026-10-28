import { launchPulseBrowser, PULSE_GROUPS } from "@codesentra/checks";
import { pulseHandler } from "@codesentra/checks/job";
import { schema as s } from "@codesentra/db";
import {
  ACCESS_PROTECTED_BYPASS,
  type FakeSlack,
  type Harness,
  startFakeSlack,
  startHarness,
} from "@codesentra/fixture-harness";
import { linkHandler } from "@codesentra/link/job";
import { isSlackWebhookUrl } from "@codesentra/notify";
import { runDueSchedules } from "@codesentra/queue";
import { testPolicy } from "@codesentra/ssrf";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Phase 5: schedules fire a Pulse (and its Link run) once per due window; alerts with the
 * issue's prompt reach email and Slack; API tokens act in one org only; run limits answer
 * 429; and every one of these is audited.
 */
let api: TestApi;
let h: Harness;
let slack: FakeSlack;
let browser: Browser;
let cookie: string;
let orgId: string;
const EMAIL = "alerts@example.com";
const slackSent: unknown[] = [];

beforeAll(async () => {
  h = await startHarness();
  slack = await startFakeSlack();
  const launched = await launchPulseBrowser();
  if (!launched.browser) throw new Error(launched.reason);
  browser = launched.browser;
  const pulse = pulseHandler({
    policy: testPolicy(["127.0.0.1"], { ca: h.caCertPem }),
    store: null,
    getBrowser: async () => ({ browser }),
    slowThresholdMs: 3000,
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
  // Link's alerts go to an in-memory mailbox and the fake Slack.
  const sent: { to: string; subject: string; text: string }[] = [];
  api = await startTestApi({
    env: {
      PULSE_TEST_ALLOW_HOSTS: "127.0.0.1",
      SLACK_CLIENT_ID: slack.clientId,
      SLACK_CLIENT_SECRET: slack.clientSecret,
      SLACK_API_BASE_URL: slack.url,
    },
    limits: { hostPerMinute: 1000 },
    handlers: {
      "pulse.run": pulse,
      "link.run": linkHandler({
        appUrl: "http://localhost:3000",
        notifier: {
          encryptionKey: Buffer.alloc(32, 7).toString("base64"),
          email: {
            kind: "outbox",
            async send(m) {
              sent.push(m);
            },
          },
          slackFetch: (url, init) => {
            if (!isSlackWebhookUrl(url, new Set(["127.0.0.1"])))
              return Promise.reject(new Error("not slack"));
            slackSent.push(url);
            return fetch(url, { ...init, redirect: "error" });
          },
        },
      }),
    },
  });
  (api as unknown as { alerts: typeof sent }).alerts = sent;
  cookie = await signIn(api, EMAIL);
  orgId = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json()
    .organizations[0].id;
}, 180_000);

afterAll(async () => {
  await api?.close();
  await browser?.close();
  await slack?.close();
  await h?.close();
});

const alerts = () =>
  (api as unknown as { alerts: { to: string; subject: string; text: string }[] }).alerts;

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

async function project(name: string, url: string) {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: as(cookie),
    payload: { org_id: orgId, name, environments: [{ name: "production", url }] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; environments: { id: string }[] };
}

describe("schedules", () => {
  it("validates, fires once per window, and deletes", async () => {
    const p = await project("scheduled", h.targets.apps.healthy?.url as string);
    const env = p.environments[0]?.id as string;
    const post = (cron: string) =>
      api.app.inject({
        method: "POST",
        url: `/v1/projects/${p.id}/schedules`,
        headers: as(cookie),
        payload: { environment_id: env, cron },
      });
    expect((await post("not a cron")).statusCode).toBe(400);
    const tooOften = await post("* * * * *");
    expect(tooOften.statusCode).toBe(400);
    expect(tooOften.json().detail).toContain("minimum is 5");
    const created = await post("*/10 * * * *");
    expect(created.statusCode, created.body).toBe(201);
    const schedule = created.json();
    expect(schedule).toMatchObject({ cron: "*/10 * * * *", run_type: "pulse", enabled: true });

    // Due (an hour from now): one Pulse with its Link run, triggered by the schedule.
    const later = new Date(Date.now() + 3600_000);
    const first = await runDueSchedules(
      { db: api.t.db, queue: api.queue, pulseSteps: PULSE_GROUPS },
      later,
    );
    expect(first.started.map((x) => x.scheduleId)).toEqual([schedule.id]);
    // The same window again: nothing (next_run_at already moved past it).
    const again = await runDueSchedules(
      { db: api.t.db, queue: api.queue, pulseSteps: PULSE_GROUPS },
      later,
    );
    expect(again.started).toEqual([]);
    const link = await waitForRun(first.started[0]?.linkRunId as string);
    expect(link.trigger).toBe("schedule");
    expect(link.children).toEqual([
      expect.objectContaining({ type: "pulse", trigger: "schedule", status: "succeeded" }),
    ]);
    const listed = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/schedules`,
        headers: { cookie },
      })
    ).json();
    expect(listed[0]).toMatchObject({ id: schedule.id, last_run_id: link.id });
    expect(new Date(listed[0].next_run_at).getTime()).toBeGreaterThan(later.getTime());

    const del = await api.app.inject({
      method: "DELETE",
      url: `/v1/projects/${p.id}/schedules?schedule_id=${schedule.id}`,
      headers: as(cookie),
    });
    expect(del.statusCode).toBe(204);
  }, 120_000);
});

describe("notifications", () => {
  it("emails members only, connects Slack by OAuth, and alerts with the prompt", async () => {
    const p = await project("alerted", h.targets.apps["env-undefined"]?.url as string);
    const outsider = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/notifications`,
      headers: as(cookie),
      payload: { kind: "email", email: "someone@else.example" },
    });
    expect(outsider.statusCode).toBe(400);
    const email = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/notifications`,
      headers: as(cookie),
      payload: { kind: "email", email: EMAIL },
    });
    expect(email.statusCode, email.body).toBe(201);
    expect(email.json().label).toBe("a***@example.com");

    // Add to Slack: our redirect → Slack → callback with a code.
    const start = await api.app.inject({
      method: "GET",
      url: `/v1/projects/${p.id}/notifications/slack/install`,
      headers: { cookie },
    });
    expect(start.statusCode, start.body).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;
    slack.authorize("slack-code", "#alerts");
    const cb = await api.app.inject({
      method: "GET",
      url: `/v1/slack/callback?code=slack-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(cb.statusCode, cb.body).toBe(302);
    expect(cb.headers.location).toContain("slack=connected");
    const channels = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/notifications`,
        headers: { cookie },
      })
    ).json();
    expect(
      channels.map((c: { kind: string; label: string }) => `${c.kind}:${c.label}`).sort(),
    ).toEqual(["email:a***@example.com", "slack:#alerts"]);
    // Destinations are sealed at rest.
    const rows = await api.t.db.system.select().from(s.notificationChannels);
    for (const r of rows) {
      expect(r.sealed).toMatch(/^v2\./);
      expect(r.sealed).not.toContain("example.com");
      expect(r.sealed).not.toContain("/services/");
    }

    const before = alerts().length;
    const res = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/pulse`,
      headers: as(cookie),
      payload: { environment_id: p.environments[0]?.id },
    });
    expect(res.statusCode, res.body).toBe(202);
    const link = await waitForRun(res.json().link_run_id);
    expect(link.outcome.notifications).toEqual({ sent: 2, failed: 0 });
    const mail = alerts().slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toBe(EMAIL);
    expect(mail[0]?.subject).toContain("alerted");
    expect(mail[0]?.text).toContain("UNDEFINED_IN_URL");
    expect(mail[0]?.text).toContain("Fix prompt");
    // No Scan of the source here, so the prompt is an honest "investigate" lead.
    expect(mail[0]?.text).toContain("Fix prompt (investigate)");
    expect(mail[0]?.text).toContain("Investigate and confirm the cause");
    const posted = slack.messages.at(-1);
    expect(posted?.channel).toBe("#alerts");
    expect(JSON.stringify(posted?.body.blocks)).toContain("Investigate and confirm the cause");

    // The same issue on the next run is not new: no second alert.
    const again = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/pulse`,
      headers: as(cookie),
      payload: { environment_id: p.environments[0]?.id },
    });
    const link2 = await waitForRun(again.json().link_run_id);
    expect(link2.outcome.notifications).toBeUndefined();
    expect(alerts().length).toBe(before + 1);
  }, 180_000);
});

describe("API tokens", () => {
  it("act in one org only, cannot mint tokens, and stop working when revoked", async () => {
    const created = await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/tokens`,
      headers: as(cookie),
      payload: { name: "laptop" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token, id, prefix } = created.json();
    expect(token).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(prefix)).toBe(true);
    const [stored] = await api.t.db.system.select().from(s.apiTokens).where(eq(s.apiTokens.id, id));
    expect(stored?.tokenHash).not.toContain(token);

    const bearer = { authorization: `Bearer ${token}` };
    const me = await api.app.inject({ method: "GET", url: "/v1/me", headers: bearer });
    expect(me.statusCode).toBe(200);
    expect(me.json().organizations.map((o: { id: string }) => o.id)).toEqual([orgId]);
    // State-changing requests work without an Origin (no cookie, no CSRF).
    const proj = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: bearer,
      payload: { org_id: orgId, name: "via-token" },
    });
    expect(proj.statusCode, proj.body).toBe(201);

    // Another org of the same user is invisible to the token.
    const other = await api.app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: as(cookie),
      payload: { name: "second" },
    });
    const otherOrg = other.json().id;
    const leak = await api.app.inject({
      method: "GET",
      url: `/v1/projects?org_id=${otherOrg}`,
      headers: bearer,
    });
    expect(leak.statusCode).toBe(404);
    const mint = await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/tokens`,
      headers: bearer,
      payload: { name: "from a token" },
    });
    expect(mint.statusCode).toBe(403);

    const revoke = await api.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${orgId}/tokens/${id}`,
      headers: as(cookie),
    });
    expect(revoke.statusCode).toBe(204);
    const after = await api.app.inject({ method: "GET", url: "/v1/me", headers: bearer });
    expect(after.statusCode).toBe(401);
    const bogus = await api.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer cs_not-a-real-token" },
    });
    expect(bogus.statusCode).toBe(401);

    const audit = (
      await api.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/audit`, headers: { cookie } })
    ).json() as { action: string }[];
    const actions = audit.map((a) => a.action);
    for (const a of [
      "api_token.created",
      "api_token.revoked",
      "schedule.created",
      "schedule.deleted",
      "notification_channel.created",
    ])
      expect(actions, a).toContain(a);
  });
});

describe("run limits (Section 17)", () => {
  it("answers 429 with Retry-After past the per-type limit", async () => {
    const limited = await startTestApi({
      env: { PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
      limits: { typePerHour: { pulse: 2 }, hostPerMinute: 1000 },
    });
    try {
      const c = await signIn(limited, "limits@example.com");
      const org = (
        await limited.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: c } })
      ).json().organizations[0].id;
      const pulse = () =>
        limited.app.inject({
          method: "POST",
          url: "/v1/pulse",
          headers: as(c),
          payload: { org_id: org, url: h.targets.apps.healthy?.url },
        });
      expect((await pulse()).statusCode).toBe(202);
      expect((await pulse()).statusCode).toBe(202);
      const third = await pulse();
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBe("3600");
      expect(third.json().detail).toContain("limit 2");
    } finally {
      await limited.close();
    }
  });

  it("limits checks of one target host across orgs", async () => {
    const limited = await startTestApi({
      env: { PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
      limits: { hostPerMinute: 1 },
    });
    try {
      const a = await signIn(limited, "host-a@example.com");
      const b = await signIn(limited, "host-b@example.com");
      const orgOf = async (c: string) =>
        (await limited.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: c } })).json()
          .organizations[0].id;
      const url = h.targets.apps.healthy?.url;
      const first = await limited.app.inject({
        method: "POST",
        url: "/v1/pulse",
        headers: as(a),
        payload: { org_id: await orgOf(a), url },
      });
      expect(first.statusCode).toBe(202);
      const second = await limited.app.inject({
        method: "POST",
        url: "/v1/pulse",
        headers: as(b),
        payload: { org_id: await orgOf(b), url },
      });
      expect(second.statusCode).toBe(429);
      expect(second.headers["retry-after"]).toBe("60");
    } finally {
      await limited.close();
    }
  });
});

describe("CLI against the API (Section 15)", () => {
  it("login stores a token; check --wait runs a full check and exits by status", async () => {
    const { run } = await import("@codesentra/cli");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const p = await project("cli-checked", h.targets.apps.healthy?.url as string);
    const token = (
      await api.app.inject({
        method: "POST",
        url: `/v1/orgs/${orgId}/tokens`,
        headers: as(cookie),
        payload: { name: "ci" },
      })
    ).json().token as string;
    const address = await api.app.listen({ port: 0, host: "127.0.0.1" });
    const out: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: () => {} };
    const deps = {
      env: { CODESENTRA_CONFIG: join(await mkdtemp(join(tmpdir(), "cs-cli-")), "c.json") },
      launchBrowser: async () => ({ browser: null, reason: "unused" }) as const,
      remote: {
        readStdin: async () => token,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 300))),
      },
    };
    expect(await run(["login", "--api", address, "--token", "-"], io, deps)).toBe(0);
    expect(out.join("")).toContain("as alerts@example.com");
    const code = await run(["check", "--project", p.id, "--wait", "--json"], io, deps);
    const result = JSON.parse(out.at(-1) as string);
    // No snapshot or repo: Scan is not run, which is a gap, so the exit is 1, not 0.
    expect(result.deployments).toEqual([{ url: h.targets.apps.healthy?.url, status: "live" }]);
    expect(result.issues).toEqual([]);
    expect(code).toBe(result.not_checked.length ? 1 : 0);
    const [run0] = await api.t.db.system.select().from(s.runs).where(eq(s.runs.id, result.run_id));
    expect(run0?.requestedBy).not.toBeNull();
    expect(run0?.trigger).toBe("cli");
  }, 120_000);
});

describe("bypass tokens (Section 9, 17)", () => {
  it("reach a protected preview, are sealed, and never appear in evidence", async () => {
    const p = await project("protected", h.targets.simulators["access-protected"]?.url as string);
    const env = p.environments[0]?.id as string;
    const pulse = async () => {
      const res = await api.app.inject({
        method: "POST",
        url: `/v1/projects/${p.id}/pulse`,
        headers: as(cookie),
        payload: { environment_id: env },
      });
      expect(res.statusCode, res.body).toBe(202);
      return waitForRun(res.json().run_id);
    };
    expect((await pulse()).outcome.pulse_status).toBe("unverified");

    const set = await api.app.inject({
      method: "PUT",
      url: `/v1/projects/${p.id}/environments/${env}/bypass-token`,
      headers: as(cookie),
      payload: { token: ACCESS_PROTECTED_BYPASS },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().has_bypass_token).toBe(true);
    expect(set.body).not.toContain(ACCESS_PROTECTED_BYPASS);
    const [row] = await api.t.db.system
      .select()
      .from(s.environments)
      .where(eq(s.environments.id, env));
    expect(row?.bypassTokenRef).toMatch(/^v2\./);
    expect(row?.bypassTokenRef).not.toContain(ACCESS_PROTECTED_BYPASS);

    const run = await pulse();
    expect(run.outcome.pulse_status).toBe("live");
    const evidence = await api.t.db.system
      .select()
      .from(s.evidence)
      .where(eq(s.evidence.runId, run.id));
    expect(evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toContain(ACCESS_PROTECTED_BYPASS);
    const findings = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/findings`,
      headers: { cookie },
    });
    expect(findings.body).not.toContain(ACCESS_PROTECTED_BYPASS);

    const del = await api.app.inject({
      method: "DELETE",
      url: `/v1/projects/${p.id}/environments/${env}/bypass-token`,
      headers: as(cookie),
    });
    expect(del.statusCode).toBe(204);
    expect((await pulse()).outcome.pulse_status).toBe("unverified");
  }, 120_000);
});
