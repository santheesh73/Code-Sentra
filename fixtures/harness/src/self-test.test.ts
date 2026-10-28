import type { Browser } from "playwright-core";
import { describe, expect, it } from "vitest";
import { observe } from "./self-test.js";

/** A browser whose pages fail navigation with `failures` errors, then load an empty page. */
function stubBrowser(failures: string[]) {
  const closed: number[] = [];
  let contexts = 0;
  const browser = {
    async newContext() {
      const n = contexts++;
      return {
        async newPage() {
          return {
            on() {},
            async goto() {
              const f = failures[n];
              if (f) throw new Error(`page.goto: ${f} at http://127.0.0.1/`);
            },
            async waitForTimeout() {},
            async evaluate() {
              return 42;
            },
            async $$eval() {
              return [];
            },
          };
        },
        async close() {
          closed.push(n);
        },
      };
    },
  } as unknown as Browser;
  return { browser, closed, contexts: () => contexts };
}

describe("observe", () => {
  it("observes again when the navigation itself hits a network change", async () => {
    const b = stubBrowser(["net::ERR_NETWORK_CHANGED"]);
    const obs = await observe(b.browser, "http://127.0.0.1/");
    expect(obs.textLength).toBe(42);
    expect(b.contexts()).toBe(2);
    expect(b.closed).toEqual([0, 1]);
  });

  it("retries only once, and lets any other failure stand", async () => {
    const twice = stubBrowser(["net::ERR_NETWORK_CHANGED", "net::ERR_NETWORK_CHANGED"]);
    await expect(observe(twice.browser, "http://127.0.0.1/")).rejects.toThrow(
      "ERR_NETWORK_CHANGED",
    );
    expect(twice.closed).toEqual([0, 1]);
    const refused = stubBrowser(["net::ERR_CONNECTION_REFUSED"]);
    await expect(observe(refused.browser, "http://127.0.0.1/")).rejects.toThrow("REFUSED");
    expect(refused.contexts()).toBe(1);
    expect(refused.closed).toEqual([0]);
  });
});
