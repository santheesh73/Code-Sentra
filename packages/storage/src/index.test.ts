import { describe, expect, it } from "vitest";
import { createObjectStore, objectStoreFromEnv } from "./index.js";

describe("object store", () => {
  const store = createObjectStore({
    endpoint: "http://127.0.0.1:1",
    bucket: "b",
    accessKeyId: "k",
    secretAccessKey: "s",
  });

  it("rejects unsafe keys before any request", async () => {
    for (const key of ["../etc/passwd", "/abs", "a/../b", "", "has space", "x".repeat(1025)]) {
      await expect(store.put(key, "x"), key).rejects.toThrow(/unsafe object key/);
    }
  });

  it("is null when s3 is not configured", () => {
    expect(objectStoreFromEnv({ integrations: { s3: false } })).toBeNull();
  });

  it("refuses an inconsistent configured state", () => {
    expect(() => objectStoreFromEnv({ integrations: { s3: true }, S3_BUCKET: "b" })).toThrow();
  });
});
