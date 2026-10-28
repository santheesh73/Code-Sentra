import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObjectStore, type ObjectStore } from "./index.js";

/** Presigned browser uploads against real MinIO (Section 8.1 size limits enforced by storage). */
let minio: StartedTestContainer;
let store: ObjectStore;

beforeAll(async () => {
  minio = await new GenericContainer("pgsty/minio:RELEASE.2026-08-04T00-00-00Z")
    .withCommand(["server", "/data"])
    .withEnvironment({ MINIO_ROOT_USER: "cs-test", MINIO_ROOT_PASSWORD: "cs-test-password-123" })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .start();
  await minio.exec([
    "sh",
    "-c",
    "mc alias set l http://127.0.0.1:9000 cs-test cs-test-password-123 && mc mb l/cs-uploads",
  ]);
  store = createObjectStore({
    endpoint: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
    bucket: "cs-uploads",
    accessKeyId: "cs-test",
    secretAccessKey: "cs-test-password-123",
  });
}, 180_000);
afterAll(() => minio?.stop());

async function post(key: string, body: Buffer, contentType = "application/zip", maxBytes = 1024) {
  const p = await store.presignUpload(key, { maxBytes, contentType: "application/zip" });
  const form = new FormData();
  for (const [k, v] of Object.entries(p.fields)) form.append(k, v);
  form.set("Content-Type", contentType);
  form.append("file", new Blob([body]), "upload.zip");
  return fetch(p.url, { method: "POST", body: form });
}

describe("presigned uploads", () => {
  it("accept a file within the limit, readable by stat and range", async () => {
    const res = await post("snapshots/o/a.zip", Buffer.from("PK\u0003\u0004 small zip"));
    expect(res.status, await res.text()).toBeLessThan(300);
    expect(await store.stat("snapshots/o/a.zip")).toEqual({ size: 14 });
    expect(Buffer.from(await store.getRange("snapshots/o/a.zip", 0, 3))).toEqual(
      Buffer.from("PK\u0003\u0004"),
    );
    expect(await store.stat("snapshots/o/missing.zip")).toBeNull();
  });

  it("are refused by storage when too large or of another type", async () => {
    expect((await post("snapshots/o/big.zip", Buffer.alloc(2048, 1))).status).toBe(400);
    expect(await store.stat("snapshots/o/big.zip")).toBeNull();
    expect((await post("snapshots/o/t.zip", Buffer.from("x"), "text/html")).status).toBe(403);
    expect(await store.stat("snapshots/o/t.zip")).toBeNull();
  });

  it("deletes everything under an org's prefix, and nothing else", async () => {
    const org = "11111111-2222-4333-8444-555555555555";
    for (const k of [`snapshots/${org}/a.zip`, `snapshots/${org}/b.zip`, "snapshots/other/c.zip"])
      await store.put(k, "x");
    expect(await store.deletePrefix(`snapshots/${org}/`)).toBe(2);
    expect(await store.stat(`snapshots/${org}/a.zip`)).toBeNull();
    expect(await store.stat("snapshots/other/c.zip")).toEqual({ size: 1 });
    await expect(store.deletePrefix("")).rejects.toThrow(/refusing/);
    await expect(store.deletePrefix("snapshots/")).rejects.toThrow(/refusing/);
  });
});
