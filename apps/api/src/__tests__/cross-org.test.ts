import { schema as s } from "@codesentra/db";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNBUILT } from "../routes/unbuilt.js";
import { as, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Section 17: "tests that try cross-org access on every route". User A attacks every
 * tenant route with org B's identifiers and must get 404 (no existence leak), and B's
 * data must be unchanged afterwards. Every registered route must be classified here,
 * so adding a route without deciding its tenancy fails this test.
 */

let api: TestApi;
let attacker: string;
let victim: string;
const B = { org: "", user: "", project: "", run: "" };

beforeAll(async () => {
  api = await startTestApi();
  attacker = await signIn(api, "attacker@example.com");
  victim = await signIn(api, "victim@example.com");
  const me = (
    await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: victim } })
  ).json();
  B.org = me.organizations[0].id;
  B.user = me.user.id;
  const p = await api.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: as(victim),
    payload: {
      org_id: B.org,
      name: "secret",
      environments: [{ name: "production", url: "https://secret.example.com" }],
    },
  });
  B.project = p.json().id;
  B.run = (
    await api.app.inject({
      method: "POST",
      url: `/v1/projects/${B.project}/diagnostic`,
      headers: as(victim),
    })
  ).json().run_id;
}, 180_000);
afterAll(async () => api?.close());

type Attack = { url: string; payload?: unknown };

/** Routes that carry no tenant resource identifier, with the reason. */
const NOT_TENANT_SCOPED: Record<string, string> = {
  "GET /health": "public liveness",
  "GET /v1/openapi.json": "public API description",
  "POST /v1/auth/email": "unauthenticated sign-in",
  "POST /v1/auth/email/verify": "unauthenticated sign-in",
  "GET /v1/auth/github": "unauthenticated sign-in",
  "GET /v1/auth/github/callback": "unauthenticated sign-in",
  "POST /v1/auth/logout": "acts on the caller's own session",
  "GET /v1/me": "the caller's own identity",
  "GET /v1/orgs": "lists only the caller's memberships",
  "POST /v1/orgs": "creates a new org owned by the caller",
  "POST /v1/pulse": "unbuilt; takes a public URL, no tenant id",
  "POST /v1/webhooks/github": "unbuilt; HMAC-authenticated by GitHub, not by session",
  "GET /v1/issues/:id": "unbuilt; issues do not exist until Phase 2 (re-classify then)",
  "GET /v1/issues/:id/fix-prompt": "unbuilt; issues do not exist until Phase 2",
  "POST /v1/issues/:id/recheck": "unbuilt; issues do not exist until Phase 2",
  "POST /v1/issues/:id/dismiss": "unbuilt; issues do not exist until Phase 2",
  "GET /v1/evidence/:id": "unbuilt; evidence does not exist until Phase 2",
};

const attacks = (): Record<string, Attack> => {
  const a: Record<string, Attack> = {
    "GET /v1/orgs/:orgId/members": { url: `/v1/orgs/${B.org}/members` },
    "POST /v1/orgs/:orgId/members": {
      url: `/v1/orgs/${B.org}/members`,
      payload: { email: "attacker@example.com", role: "owner" },
    },
    "PATCH /v1/orgs/:orgId/members/:userId": {
      url: `/v1/orgs/${B.org}/members/${B.user}`,
      payload: { role: "member" },
    },
    "DELETE /v1/orgs/:orgId/members/:userId": { url: `/v1/orgs/${B.org}/members/${B.user}` },
    "POST /v1/projects": { url: "/v1/projects", payload: { org_id: B.org, name: "planted" } },
    "GET /v1/projects": { url: `/v1/projects?org_id=${B.org}` },
    "GET /v1/projects/:id": { url: `/v1/projects/${B.project}` },
    "PATCH /v1/projects/:id": { url: `/v1/projects/${B.project}`, payload: { name: "pwned" } },
    "DELETE /v1/projects/:id": { url: `/v1/projects/${B.project}` },
    "POST /v1/projects/:id/environments": {
      url: `/v1/projects/${B.project}/environments`,
      payload: { name: "evil", url: "https://evil.example" },
    },
    "GET /v1/projects/:id/runs": { url: `/v1/projects/${B.project}/runs` },
    "POST /v1/projects/:id/diagnostic": { url: `/v1/projects/${B.project}/diagnostic` },
    "GET /v1/runs/:id": { url: `/v1/runs/${B.run}` },
    "GET /v1/runs/:id/stream": { url: `/v1/runs/${B.run}/stream` },
  };
  for (const r of UNBUILT) {
    if (r.scope === "project")
      a[`${r.method} ${r.url}`] = { url: r.url.replace(":id", B.project), payload: {} };
    if (r.scope === "run")
      a[`${r.method} ${r.url}`] = { url: r.url.replace(":id", B.run), payload: {} };
  }
  return a;
};

async function snapshotB() {
  const sys = api.t.db.system;
  const [project] = await sys.select().from(s.projects).where(eq(s.projects.id, B.project));
  const [{ envs }] = (await sys
    .select({ envs: count() })
    .from(s.environments)
    .where(eq(s.environments.projectId, B.project))) as [{ envs: number }];
  const [{ runs }] = (await sys
    .select({ runs: count() })
    .from(s.runs)
    .where(eq(s.runs.orgId, B.org))) as [{ runs: number }];
  const members = await sys
    .select({ userId: s.memberships.userId, role: s.memberships.role })
    .from(s.memberships)
    .where(eq(s.memberships.orgId, B.org));
  const [{ projects }] = (await sys
    .select({ projects: count() })
    .from(s.projects)
    .where(eq(s.projects.orgId, B.org))) as [{ projects: number }];
  return { name: project?.name, envs, runs, projects, members };
}

describe("cross-org access", () => {
  it("classifies every registered route", () => {
    const registered = api.routes.map((r) => `${r.method} ${r.url}`).sort();
    const classified = [...Object.keys(NOT_TENANT_SCOPED), ...Object.keys(attacks())].sort();
    expect(registered).toEqual(classified);
  });

  it("answers 404 on every tenant route and leaves the other org untouched", async () => {
    const before = await snapshotB();
    for (const [key, attack] of Object.entries(attacks())) {
      const method = key.split(" ")[0] as "GET" | "POST" | "PATCH" | "DELETE";
      const res = await api.app.inject({
        method,
        url: attack.url,
        headers: as(attacker),
        ...(attack.payload !== undefined ? { payload: attack.payload } : {}),
      });
      expect(res.statusCode, `${key} → ${res.body.slice(0, 200)}`).toBe(404);
      expect(res.body, key).not.toContain("secret.example.com");
    }
    expect(await snapshotB()).toEqual(before);
  });

  it("unauthenticated requests to tenant routes get 401, not data", async () => {
    for (const [key, attack] of Object.entries(attacks())) {
      const method = key.split(" ")[0] as "GET" | "POST" | "PATCH" | "DELETE";
      const res = await api.app.inject({
        method,
        url: attack.url,
        headers: { origin: "http://localhost:3000" },
        ...(attack.payload !== undefined ? { payload: attack.payload } : {}),
      });
      expect(res.statusCode, key).toBe(401);
    }
  });

  it("the victim still has full access", async () => {
    const res = await api.app.inject({
      method: "GET",
      url: `/v1/projects/${B.project}`,
      headers: { cookie: victim },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("secret");
  });
});
