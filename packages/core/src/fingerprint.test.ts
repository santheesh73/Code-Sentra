import { describe, expect, it } from "vitest";
import { parseCodeLocator } from "./evidence.js";
import { normalizeLocator } from "./fingerprint.js";
import { evidenceHash, fingerprint } from "./hashing.js";
import { canonicalJson } from "./json.js";

describe("normalizeLocator (pulse)", () => {
  it("drops query strings and fragments", () => {
    expect(normalizeLocator("pulse", "https://Example.com/api/ping?x=1#top")).toBe(
      "https://example.com/api/ping",
    );
  });

  it("drops default ports but keeps others", () => {
    expect(normalizeLocator("pulse", "https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeLocator("pulse", "http://localhost:4000/data")).toBe(
      "http://localhost:4000/data",
    );
  });

  it("strips Next.js build ids", () => {
    expect(
      normalizeLocator("pulse", "https://x.dev/_next/static/AbC123xyz/_buildManifest.js"),
    ).toBe("https://x.dev/_next/static/[build]/_buildManifest.js");
    expect(
      normalizeLocator("pulse", "https://x.dev/_next/static/OTHERBUILD9/_buildManifest.js"),
    ).toBe("https://x.dev/_next/static/[build]/_buildManifest.js");
  });

  it("does not treat chunks/css/media as build ids", () => {
    expect(normalizeLocator("pulse", "https://x.dev/_next/static/chunks/app.js")).toBe(
      "https://x.dev/_next/static/chunks/app.js",
    );
  });

  it("strips asset content hashes", () => {
    expect(normalizeLocator("pulse", "https://x.dev/assets/main-3f2a9c1b.js")).toBe(
      "https://x.dev/assets/main-[hash].js",
    );
    expect(normalizeLocator("pulse", "https://x.dev/_next/static/chunks/0a1b2c3d4e5f6789.js")).toBe(
      "https://x.dev/_next/static/chunks/[hash].js",
    );
    expect(normalizeLocator("pulse", "https://x.dev/jquery-3.7.1.min.js")).toBe(
      "https://x.dev/jquery-3.7.1.min.js",
    );
  });

  it("strips line and column suffixes", () => {
    expect(normalizeLocator("pulse", "https://x.dev/assets/app-9f8e7d6c.js:12:34")).toBe(
      "https://x.dev/assets/app-[hash].js",
    );
  });

  it("keeps API paths intact", () => {
    expect(normalizeLocator("pulse", "https://x.dev/undefined/api/ping")).toBe(
      "https://x.dev/undefined/api/ping",
    );
  });
});

describe("normalizeLocator (scan)", () => {
  it("drops line numbers but keeps path and symbol", () => {
    expect(normalizeLocator("scan", "src/app/page.tsx:12")).toBe("src/app/page.tsx");
    expect(normalizeLocator("scan", "./src/app/page.tsx:12:5#Home")).toBe("src/app/page.tsx#Home");
    expect(normalizeLocator("scan", "src\\lib\\db.ts:3")).toBe("src/lib/db.ts");
  });

  it("leaves non-path locators as-is", () => {
    expect(normalizeLocator("scan", "npm:lodash@4.17.15")).toBe("npm:lodash@4.17.15");
  });
});

describe("fingerprint", () => {
  it("is stable across cosmetic locator changes", () => {
    const a = fingerprint("UNDEFINED_IN_URL", "pulse", "https://x.dev/undefined/api/ping?t=1");
    const b = fingerprint("UNDEFINED_IN_URL", "pulse", "https://X.dev/undefined/api/ping#a");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates codes and discriminators", () => {
    const base = fingerprint("CONSOLE_ERROR", "pulse", "https://x.dev/", "boom");
    expect(fingerprint("UNCAUGHT_EXCEPTION", "pulse", "https://x.dev/", "boom")).not.toBe(base);
    expect(fingerprint("CONSOLE_ERROR", "pulse", "https://x.dev/", "other")).not.toBe(base);
    expect(fingerprint("CONSOLE_ERROR", "pulse", "https://x.dev/", "  boom \n")).toBe(base);
  });

  it("is stable when scan lines move", () => {
    expect(fingerprint("TODO_MARKER", "scan", "src/a.ts:10")).toBe(
      fingerprint("TODO_MARKER", "scan", "src/a.ts:42"),
    );
  });
});

describe("evidenceHash / canonicalJson", () => {
  it("ignores key order", () => {
    const a = evidenceHash({
      kind: "http_response",
      locator: "https://x.dev/",
      payload: { a: 1, b: [1, { c: 2, d: 3 }] },
    });
    const b = evidenceHash({
      kind: "http_response",
      locator: "https://x.dev/",
      payload: { b: [1, { d: 3, c: 2 }], a: 1 },
    });
    expect(a).toBe(b);
  });

  it("changes when payload changes", () => {
    const a = evidenceHash({ kind: "http_response", locator: "u", payload: { status: 200 } });
    const b = evidenceHash({ kind: "http_response", locator: "u", payload: { status: 500 } });
    expect(a).not.toBe(b);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});

describe("parseCodeLocator", () => {
  it("parses path, line, column and symbol", () => {
    expect(parseCodeLocator("app/page.tsx:12:5#Home")).toEqual({
      path: "app/page.tsx",
      line: 12,
      column: 5,
      symbol: "Home",
    });
    expect(parseCodeLocator("README.md")).toEqual({ path: "README.md" });
    expect(parseCodeLocator("https://x.dev/a")).toBeNull();
  });
});
