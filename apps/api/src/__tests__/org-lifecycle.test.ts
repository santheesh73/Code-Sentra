import { schema as s, TENANT_TABLES } from "@codesentra/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, memoryStore, seedIssue, signIn, startTestApi, type TestApi } from "./helpers.js";

/** Invitations and organization deletion (ADR 0024). */
let api: TestApi;
let owner: string;
const store = memoryStore();

beforeAll(async () => {
  api = await startTestApi({ store });
  owner = await signIn(api, "lifecycle@example.com");
}, 120_000);
afterAll(() => api?.close());

const me = async () =>
  (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: owner } })).json() as {
    organizations: { id: string; slug: string }[];
  };

describe("invitations", () => {
  it("adding a member emails them an invitation", async () => {
    const org = (await me()).organizations[0] as { id: string };
    const before = api.mail.sent.length;
    const res = await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.id}/members`,
      headers: as(owner),
      payload: { email: "New.Person@Example.com", role: "member" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().invitation).toBe("sent");
    const mail = api.mail.sent.slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toBe("new.person@example.com");
    expect(mail[0]?.subject).toContain("You were added to");
    expect(mail[0]?.text).toContain("lifecycle@example.com added you");
    expect(mail[0]?.text).toContain("/signin");
  });
});

describe("deleting an organization", () => {
  it("needs the slug, refuses your only org, and removes every row and stored object", async () => {
    const only = (await me()).organizations[0] as { id: string; slug: string };
    const refuse = await api.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${only.id}`,
      headers: as(owner),
      payload: { confirm: only.slug },
    });
    expect(refuse.statusCode).toBe(400);
    expect(refuse.json().detail).toContain("only organization");

    const created = await api.app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: as(owner),
      payload: { name: "Doomed" },
    });
    const doomed = created.json() as { id: string; slug: string };
    // Fill it: a project with an environment, a run with an issue, a schedule, a token.
    const project = (
      await api.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: as(owner),
        payload: {
          org_id: doomed.id,
          name: "p",
          environments: [{ name: "production", url: "https://example.com/" }],
        },
      })
    ).json();
    const run = (
      await api.app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/diagnostic`,
        headers: as(owner),
      })
    ).json();
    await seedIssue(api, doomed.id, project.id, run.run_id);
    await api.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/schedules`,
      headers: as(owner),
      payload: { environment_id: project.environments[0].id, cron: "0 6 * * *" },
    });
    await api.app.inject({
      method: "POST",
      url: `/v1/orgs/${doomed.id}/tokens`,
      headers: as(owner),
      payload: { name: "t" },
    });
    store.objects.set(`snapshots/${doomed.id}/x.zip`, Buffer.from("PK"));
    store.objects.set(`screenshots/${doomed.id}/y.png`, Buffer.from("png"));
    store.objects.set(`snapshots/${only.id}/keep.zip`, Buffer.from("PK"));

    const wrong = await api.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${doomed.id}`,
      headers: as(owner),
      payload: { confirm: "doomed" },
    });
    expect(wrong.statusCode).toBe(400);
    const del = await api.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${doomed.id}`,
      headers: as(owner),
      payload: { confirm: doomed.slug },
    });
    expect(del.statusCode, del.body).toBe(204);

    for (const table of TENANT_TABLES) {
      const r = await api.t.db.system.execute<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(table)} where org_id = ${doomed.id}`,
      );
      expect(r.rows[0]?.n, table).toBe("0");
    }
    const [{ n }] = (
      await api.t.db.system.execute<{ n: string }>(
        sql`select count(*)::text as n from ${s.organizations} where id = ${doomed.id}`,
      )
    ).rows as [{ n: string }];
    expect(n).toBe("0");
    expect([...store.objects.keys()].filter((k) => k.includes(doomed.id))).toEqual([]);
    expect(store.objects.has(`snapshots/${only.id}/keep.zip`)).toBe(true);
    expect((await me()).organizations.map((o) => o.id)).toEqual([only.id]);
  });
});
