import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isSealedWith, keyId, keyring, openSecret, sealSecret } from "./crypto.js";

const key = Buffer.alloc(32, 9).toString("base64");
const other = Buffer.alloc(32, 8).toString("base64");

describe("sealed secrets", () => {
  it("round-trips, and never repeats a ciphertext", () => {
    const a = sealSecret("xoxb-secret", key, "slack-webhook");
    const b = sealSecret("xoxb-secret", key, "slack-webhook");
    expect(a).not.toBe(b);
    expect(a).not.toContain("xoxb-secret");
    expect(openSecret(a, key, "slack-webhook")).toBe("xoxb-secret");
  });

  it("refuses the wrong key, the wrong purpose and tampering", () => {
    const s = sealSecret("value", key, "github-installation");
    expect(() => openSecret(s, other, "github-installation")).toThrow();
    expect(() => openSecret(s, key, "slack-webhook")).toThrow();
    const parts = s.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => openSecret(parts.join("."), key, "github-installation")).toThrow();
    expect(() => openSecret("plain text", key, "x")).toThrow(/not a sealed secret/);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => sealSecret("v", Buffer.alloc(16).toString("base64"), "x")).toThrow(/32 bytes/);
  });

  it("rotates: values open with a retired key, and know which key sealed them", () => {
    const old = sealSecret("value", other, "bypass-token");
    expect(old.startsWith(`v2.${keyId(other)}.`)).toBe(true);
    const ring = keyring(key, other);
    expect(openSecret(old, ring, "bypass-token")).toBe("value");
    expect(isSealedWith(old, ring)).toBe(false);
    const fresh = sealSecret("value", ring, "bypass-token");
    expect(isSealedWith(fresh, ring)).toBe(true);
    // Once the old key leaves the keyring, its values no longer open.
    expect(() => openSecret(old, key, "bypass-token")).toThrow(/not in the keyring/);
  });

  it("still opens the v1 format with any key of the keyring", () => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(other, "base64"), iv);
    c.setAAD(Buffer.from("github-installation"));
    const ct = Buffer.concat([c.update("legacy", "utf8"), c.final()]);
    const v1 = ["v1", iv, c.getAuthTag(), ct]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
    expect(openSecret(v1, keyring(key, other), "github-installation")).toBe("legacy");
    expect(isSealedWith(v1, key)).toBe(false);
    expect(keyring(key, " , ")).toEqual([key]);
  });
});
