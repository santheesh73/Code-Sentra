import type { ObjectStore } from "@codesentra/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryStore, startTestApi, type TestApi } from "./helpers.js";

let api: TestApi;
let storageHealthy = true;

beforeAll(async () => {
  const base = memoryStore();
  // A store whose readiness probe we can fail on demand, to prove /ready pulls the instance
  // out of rotation when a backing dependency is unreachable.
  const store: ObjectStore = {
    ...base,
    async check() {
      if (!storageHealthy) throw new Error("storage unreachable");
    },
  };
  api = await startTestApi({ store });
}, 120_000);

afterAll(() => api.close());

describe("liveness and readiness", () => {
  it("/health reports database and queue, with no auth", async () => {
    const res = await api.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", queue: "ok" } });
  });

  it("/ready probes database, queue and object storage; 200 when all reachable", async () => {
    storageHealthy = true;
    const res = await api.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      checks: { database: "ok", queue: "ok", storage: "ok" },
    });
  });

  it("/ready fails with 503 when object storage is unreachable", async () => {
    storageHealthy = false;
    try {
      const res = await api.app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({
        status: "error",
        checks: { database: "ok", queue: "ok", storage: "error" },
      });
    } finally {
      storageHealthy = true;
    }
  });

  it("/ready needs no authentication", async () => {
    const res = await api.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
  });
});

describe("readiness without object storage configured", () => {
  it("reports storage not_configured and stays ready (dev only)", async () => {
    const noStore = await startTestApi();
    try {
      const res = await noStore.app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        status: "ok",
        checks: { database: "ok", queue: "ok", storage: "not_configured" },
      });
    } finally {
      await noStore.close();
    }
  }, 120_000);
});
