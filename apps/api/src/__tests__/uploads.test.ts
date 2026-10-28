import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, memoryStore, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Direct uploads (ADR 0024): the zip goes straight to storage under a presigned policy, so
 * the web proxy's body limit does not apply; the API only checks the stored object.
 */
let api: TestApi;
let cookie: string;
let projectId: string;
const store = memoryStore();

beforeAll(async () => {
  api = await startTestApi({ store, env: { SCAN_MAX_UPLOAD_BYTES: "2048" } });
  cookie = await signIn(api, "uploads@example.com");
  const orgId = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json()
    .organizations[0].id;
  projectId = (
    await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: as(cookie),
      payload: { org_id: orgId, name: "uploads" },
    })
  ).json().id;
}, 120_000);
afterAll(() => api?.close());

const start = async () => {
  const res = await api.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/uploads`,
    headers: as(cookie),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { snapshot_id: string; fields: { key: string }; max_bytes: number };
};
const complete = (id: string) =>
  api.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/uploads/${id}/complete`,
    headers: as(cookie),
  });
const scan = (id: string) =>
  api.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/scan`,
    headers: as(cookie),
    payload: { snapshot_id: id },
  });

describe("direct uploads", () => {
  it("presign, upload to storage, complete: the snapshot is ready to scan", async () => {
    const up = await start();
    expect(up.max_bytes).toBe(2048);
    expect(up.fields.key).toMatch(new RegExp(`^snapshots/[0-9a-f-]{36}/${up.snapshot_id}\\.zip$`));
    // Not uploaded yet: not complete, and not scannable.
    expect((await complete(up.snapshot_id)).statusCode).toBe(400);
    expect((await scan(up.snapshot_id)).json().detail).toContain("not completed");

    store.objects.set(
      up.fields.key,
      Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(60)]),
    );
    const done = await complete(up.snapshot_id);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ id: up.snapshot_id, kind: "zip", size_bytes: 64 });
    // Completing twice is harmless.
    expect((await complete(up.snapshot_id)).statusCode).toBe(200);
  });

  it("rejects and deletes an object that is not a zip or is too large", async () => {
    const notZip = await start();
    store.objects.set(notZip.fields.key, Buffer.from("<html>not a zip</html>"));
    const r1 = await complete(notZip.snapshot_id);
    expect(r1.statusCode).toBe(400);
    expect(r1.json().detail).toContain("not a zip");
    expect(store.objects.has(notZip.fields.key)).toBe(false);

    const big = await start();
    store.objects.set(
      big.fields.key,
      Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(4096)]),
    );
    const r2 = await complete(big.snapshot_id);
    expect(r2.statusCode).toBe(400);
    expect(r2.json().detail).toContain("larger than 2048");
    expect(store.objects.has(big.fields.key)).toBe(false);
  });
});
