import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateOpenApi, renderApiMarkdown } from "../openapi.js";
import { UNBUILT } from "../routes/unbuilt.js";
import { as, ORIGIN, seedIssue, signIn, startTestApi, type TestApi } from "./helpers.js";

let api: TestApi;
let owner: string;
let orgId: string;

beforeAll(async () => {
  api = await startTestApi();
  owner = await signIn(api, "owner@example.com");
  orgId = (
    await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: owner } })
  ).json().organizations[0].id;
}, 180_000);
afterAll(async () => api?.close());

async function createProject(cookie = owner, body: Record<string, unknown> = {}) {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: as(cookie),
    payload: {
      org_id: orgId,
      name: "Shop",
      environments: [{ name: "production", url: "https://shop.example.com" }],
      ...body,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe("projects and environments", () => {
  it("creates, lists, reads and updates a project", async () => {
    const p = await createProject(owner, { repo_url: "https://github.com/acme/shop" });
    expect(p).toMatchObject({
      org_id: orgId,
      name: "Shop",
      repo_url: "https://github.com/acme/shop",
      latest_run: null,
    });
    expect(p.environments.map((e: { name: string }) => e.name)).toEqual(["production"]);

    const list = await api.app.inject({
      method: "GET",
      url: `/v1/projects?org_id=${orgId}`,
      headers: { cookie: owner },
    });
    expect(list.json().map((x: { id: string }) => x.id)).toContain(p.id);

    const patched = await api.app.inject({
      method: "PATCH",
      url: `/v1/projects/${p.id}`,
      headers: as(owner),
      payload: { name: "Shop 2", repo_url: null },
    });
    expect(patched.json()).toMatchObject({ name: "Shop 2", repo_url: null });
  });

  it("adds environments and rejects duplicates and unsafe URLs", async () => {
    const p = await createProject();
    const add = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/environments`,
      headers: as(owner),
      payload: { name: "preview", url: "https://preview.shop.example.com" },
    });
    expect(add.statusCode).toBe(201);
    const dup = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/environments`,
      headers: as(owner),
      payload: { name: "preview", url: "https://x.example.com" },
    });
    expect(dup.statusCode).toBe(409);
    for (const url of [
      "ftp://x.example.com",
      "javascript:alert(1)",
      "https://user:pw@x.example.com",
    ]) {
      const bad = await api.app.inject({
        method: "POST",
        url: `/v1/projects/${p.id}/environments`,
        headers: as(owner),
        payload: { name: "bad", url },
      });
      expect(bad.statusCode, url).toBe(400);
    }
  });

  it("only admins and owners can delete a project, and deletion is audited", async () => {
    const p = await createProject();
    const memberCookie = await signIn(api, "member@example.com");
    await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/members`,
      headers: as(owner),
      payload: { email: "member@example.com", role: "member" },
    });
    const denied = await api.app.inject({
      method: "DELETE",
      url: `/v1/projects/${p.id}`,
      headers: as(memberCookie),
    });
    expect(denied.statusCode).toBe(403);
    const ok = await api.app.inject({
      method: "DELETE",
      url: `/v1/projects/${p.id}`,
      headers: as(owner),
    });
    expect(ok.statusCode).toBe(204);
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: `/v1/projects/${p.id}`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(404);
    const audit = await api.t.db.withOrg(orgId, (tx) => tx.query.auditLog.findMany());
    expect(
      audit.some((a) => a.action === "project.deleted" && a.target === `project:${p.id}`),
    ).toBe(true);
  });
});

describe("members", () => {
  it("adds members, changes roles, and protects the last owner", async () => {
    const add = await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/members`,
      headers: as(owner),
      payload: { email: "admin@example.com", role: "admin" },
    });
    expect(add.statusCode).toBe(201);
    const again = await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/members`,
      headers: as(owner),
      payload: { email: "ADMIN@example.com" },
    });
    expect(again.statusCode).toBe(409);

    const list = (
      await api.app.inject({
        method: "GET",
        url: `/v1/orgs/${orgId}/members`,
        headers: { cookie: owner },
      })
    ).json();
    const ownerId = list.find((m: { role: string }) => m.role === "owner").user.id;
    const demote = await api.app.inject({
      method: "PATCH",
      url: `/v1/orgs/${orgId}/members/${ownerId}`,
      headers: as(owner),
      payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(400);
    const leave = await api.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${orgId}/members/${ownerId}`,
      headers: as(owner),
    });
    expect(leave.statusCode).toBe(400);

    const adminCookie = await signIn(api, "admin@example.com");
    const adminAddsOwner = await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/members`,
      headers: as(adminCookie),
      payload: { email: "x@example.com", role: "owner" },
    });
    expect(adminAddsOwner.statusCode).toBe(403);

    const audit = await api.t.db.withOrg(orgId, (tx) => tx.query.auditLog.findMany());
    expect(audit.filter((a) => a.action.startsWith("membership.")).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("a member who joins an org sees it on sign-in", async () => {
    await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/members`,
      headers: as(owner),
      payload: { email: "newbie@example.com" },
    });
    const cookie = await signIn(api, "newbie@example.com");
    const me = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json();
    expect(me.organizations.map((o: { id: string }) => o.id)).toEqual([orgId]);
  });
});

describe("diagnostic runs", () => {
  it("queues a run, executes it on the worker and records the gap", async () => {
    const p = await createProject();
    const start = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/diagnostic`,
      headers: as(owner),
    });
    expect(start.statusCode).toBe(202);
    const { run_id } = start.json();
    let run:
      | {
          status: string;
          steps: { name: string; status: string }[];
          gaps: { step: string; reason: string }[];
        }
      | undefined;
    for (let i = 0; i < 100; i++) {
      run = (
        await api.app.inject({
          method: "GET",
          url: `/v1/runs/${run_id}`,
          headers: { cookie: owner },
        })
      ).json();
      if (run && ["succeeded", "failed", "partial"].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(run?.status).toBe("partial");
    expect(run?.steps.map((x) => `${x.name}:${x.status}`)).toEqual([
      "database:done",
      "queue:done",
      "object_storage:skipped",
    ]);
    expect(run?.gaps).toEqual([
      { step: "object_storage", reason: expect.stringMatching(/not configured/) },
    ]);

    const runs = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}/runs`,
        headers: { cookie: owner },
      })
    ).json();
    expect(runs[0].id).toBe(run_id);
    const project = (
      await api.app.inject({
        method: "GET",
        url: `/v1/projects/${p.id}`,
        headers: { cookie: owner },
      })
    ).json();
    expect(project.latest_run.id).toBe(run_id);
  });

  it("streams live progress over SSE until the run finishes", async () => {
    const p = await createProject();
    await api.app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    // Hold the worker so the stream starts before any step runs.
    await api.worker.stop();
    const start = await fetch(`${base}/v1/projects/${p.id}/diagnostic`, {
      method: "POST",
      headers: as(owner),
    });
    const { run_id } = (await start.json()) as { run_id: string };
    const res = await fetch(`${base}/v1/runs/${run_id}/stream`, { headers: { cookie: owner } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { startWorker, diagnosticHandler } = await import("@codesentra/queue");
    api.worker = await startWorker({
      db: api.t.db,
      queue: api.queue,
      handlers: { "system.diagnostic": diagnosticHandler({ store: null }) },
    });

    const decoder = new TextDecoder();
    let buffer = "";
    const snapshots: { status: string; steps: { status: string }[] }[] = [];
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (/^event: run$/m.test(frame) && data) snapshots.push(JSON.parse(data));
        idx = buffer.indexOf("\n\n");
      }
    }
    expect(snapshots[0]?.status).toBe("queued");
    expect(
      snapshots.some(
        (x) => x.status === "running" && x.steps.some((st) => st.status === "running"),
      ),
    ).toBe(true);
    expect(snapshots.at(-1)?.status).toBe("partial");
    expect(snapshots.length).toBeGreaterThanOrEqual(5);
  });
});

describe("not yet available", () => {
  it("every unbuilt endpoint answers 501 problem+json, never canned data", async () => {
    const p = await createProject();
    const run = (
      await api.app.inject({
        method: "POST",
        url: `/v1/projects/${p.id}/diagnostic`,
        headers: as(owner),
      })
    ).json();
    const issueId = await seedIssue(api, p.org_id, p.id, run.run_id);
    for (const r of UNBUILT) {
      const id =
        r.scope === "project"
          ? p.id
          : r.scope === "run"
            ? run.run_id
            : r.scope === "issue"
              ? issueId
              : "00000000-0000-4000-8000-000000000000";
      const res = await api.app.inject({
        method: r.method,
        url: r.url.replace(":id", id),
        headers: r.scope === "none" ? {} : as(owner),
        ...(r.method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(501);
      expect(res.json()).toMatchObject({ status: 501, title: "Not yet available" });
      expect(res.json().detail).toContain(r.phase);
    }
  });

  it("requires sign-in before revealing even a 501", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/projects/00000000-0000-4000-8000-000000000000/scan",
      headers: ORIGIN,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("OpenAPI", () => {
  it("is served and matches the committed docs/openapi.json and docs/api.md", async () => {
    const served = (await api.app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
    expect(served.openapi).toBe("3.1.0");
    expect(Object.keys(served.paths)).toContain("/v1/runs/{id}/stream");
    const generated = await generateOpenApi();
    const docs = fileURLToPath(new URL("../../../../docs/", import.meta.url));
    const committed = JSON.parse(readFileSync(`${docs}openapi.json`, "utf8"));
    expect(
      committed,
      "run: pnpm --filter @codesentra/api build && pnpm --filter @codesentra/api openapi",
    ).toEqual(JSON.parse(JSON.stringify(generated)));
    expect(readFileSync(`${docs}api.md`, "utf8")).toBe(renderApiMarkdown(generated));
  });

  it("defines every schema it references", async () => {
    const doc = JSON.parse(JSON.stringify(await generateOpenApi()));
    const refs = new Set(
      [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/([\w.-]+)/g)].map((m) => m[1]),
    );
    expect(refs.size).toBeGreaterThan(10);
    expect([...refs].filter((r) => !doc.components.schemas?.[r as string])).toEqual([]);
  });
});
