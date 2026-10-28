import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./crypto.js";

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
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => openSecret(parts.join("."), key, "github-installation")).toThrow();
    expect(() => openSecret("plain text", key, "x")).toThrow(/not a sealed secret/);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => sealSecret("v", Buffer.alloc(16).toString("base64"), "x")).toThrow(/32 bytes/);
  });
});
