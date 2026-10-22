import type { PulseStatus } from "@codesentra/core";
import { type Harness, loadFixtureApps, startHarness } from "@codesentra/fixture-harness";
import { defaultPolicy, testPolicy } from "@codesentra/ssrf";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchPulseBrowser } from "./browser.js";
import { detectPlatform } from "./platforms/index.js";
import { runPulse } from "./pulse.js";
import { isLoopbackHost, undefinedTokenIn } from "./render.js";
import { linksFromHtml } from "./routes-hygiene.js";
import type { FindingDraft, PulseResult } from "./types.js";

let h: Harness;
let browser: Browser;

beforeAll(async () => {
  h = await startHarness({ slowMs: 1200 });
  const launched = await launchPulseBrowser();
  if (!launched.browser) throw new Error(launched.reason); // no silent skip (Rule 2)
  browser = launched.browser;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await h?.close();
});

const policy = () => testPolicy(["127.0.0.1", "localhost"], { ca: h.caCertPem });
const pulse = (url: string, extra: Partial<Parameters<typeof runPulse>[0]> = {}) =>
  runPulse({ url, policy: policy(), browser, timeoutMs: 3000, ...extra });

/** Error and warning findings as comparable strings: CODE path-or-message. */
function summarise(r: PulseResult): string[] {
  return r.findings
    .filter((f) => f.severity !== "info")
    .map((f: FindingDraft) => {
      if (f.code === "UNCAUGHT_EXCEPTION" || f.code === "CONSOLE_ERROR")
        return `${f.code} ${f.discriminator}`;
      if (f.code === "LOCALHOST_CALL") return `${f.code} ${f.locator}`;
      return `${f.code} ${new URL(f.locator).pathname}`;
    })
    .sort();
}

describe("fixture apps produce their documented status and findings (Phase 2 gate)", () => {
  for (const app of loadFixtureApps()) {
    for (const [variant, expected] of Object.entries(app.manifest.expected)) {
      it(`${app.manifest.name} (${variant}) → ${expected.pulseStatus}`, async () => {
        h.setVariant(app.manifest.name, variant);
        try {
          const target = h.targets.apps[app.manifest.name];
          if (!target) throw new Error("not served");
          const r = await pulse(target.url);
          const want = expected.findings
            .map((f) => {
              if (f.message) return `${f.code} ${f.message}`;
              if (f.url) return `${f.code} ${f.url}`;
              return `${f.code} ${f.path}`;
            })
            .sort();
          expect({ status: r.status, findings: summarise(r), gaps: r.gaps }).toEqual({
            status: expected.pulseStatus,
            findings: want,
            gaps: [],
          });
          expect(r.groups.every((g) => g.ran)).toBe(true);
          expect(r.screenshot?.length).toBeGreaterThan(1000);
          // Every finding cites evidence that exists.
          const keys = new Set(r.evidence.map((e) => e.key));
          for (const f of r.findings) expect(keys.has(f.evidenceKey), f.code).toBe(true);
        } finally {
          h.setVariant(app.manifest.name, app.manifest.defaultVariant);
        }
      });
    }
  }
});

describe("simulators", () => {
  const cases: [string, PulseStatus, string[], Partial<Parameters<typeof runPulse>[0]>?][] = [
    ["server-error", "down", ["SERVER_ERROR /"]],
    ["service-unavailable", "down", ["SERVER_ERROR /"]],
    ["not-found", "degraded", ["BAD_STATUS /"]],
    ["timeout", "down", ["TIMEOUT /"], { timeoutMs: 800 }],
    ["slow", "live", ["SLOW_RESPONSE /"], { slowThresholdMs: 500 }],
    ["redirect-loop", "down", ["REDIRECT_LOOP /"]],
    ["long-redirect-chain", "live", ["LONG_REDIRECT_CHAIN /"]],
    ["connection-refused", "down", ["DOWN /"]],
    ["dns-failure", "down", ["DNS_FAILURE /"]],
    ["tls-valid", "live", []],
    ["tls-expiring", "live", ["TLS_EXPIRING /"]],
    ["tls-expired", "down", ["TLS_INVALID /"]],
    ["tls-wrong-host", "down", ["TLS_INVALID /"]],
    ["tls-self-signed", "down", ["TLS_INVALID /"]],
    ["access-protected", "unverified", ["ACCESS_PROTECTED /"]],
  ];
  it.each(cases)("%s → %s", async (name, status, findings, extra) => {
    const sim = h.targets.simulators[name as keyof typeof h.targets.simulators];
    const r = await pulse(sim.url, extra);
    expect(r.status).toBe(status);
    expect(summarise(r)).toEqual(findings);
    if (status === "down") {
      expect(r.gaps.map((g) => g.group)).toEqual(["platform", "render", "routes", "hygiene"]);
    }
  });
});

describe("platform findings end to end", () => {
  it("access protection is a warning plus gaps, never live", async () => {
    const r = await pulse(h.targets.simulators["access-protected"].url);
    expect(r.platform?.name).toBe("vercel");
    expect(r.gaps.map((g) => g.group)).toEqual(["render", "routes", "hygiene"]);
    expect(r.gaps[0]?.reason).toMatch(/access protection/);
  });

  it("a preview deployment registered as production is PREVIEW_SERVED_AS_PROD", async () => {
    const sim = new URL(h.targets.simulators["preview-deployment"].url);
    const host = "shop-git-feature-x-acme.vercel.app";
    const url = `http://${host}:${sim.port}/`;
    // The test resolver sends the vercel.app name to the harness; nothing leaves the host.
    const policy = testPolicy([host], {
      resolver: async (name) => {
        if (name !== host) throw new Error(`unexpected lookup: ${name}`);
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    const asProd = await runPulse({ url, policy, browser, expectedEnvironment: "production" });
    expect(asProd.platform).toMatchObject({ name: "vercel", environment: "preview" });
    expect(asProd.status).toBe("degraded");
    expect(summarise(asProd)).toEqual(["PREVIEW_SERVED_AS_PROD /"]);
    expect(asProd.gaps).toEqual([]);

    const asPreview = await runPulse({ url, policy, browser, expectedEnvironment: "preview" });
    expect(asPreview.status).toBe("live");
    expect(summarise(asPreview)).toEqual([]);
  });
});

describe("gaps are never passes (Rule 2)", () => {
  it("without a browser, a healthy site is unverified with the render gap named", async () => {
    const r = await runPulse({
      url: h.targets.apps.healthy?.url ?? "",
      policy: policy(),
      browser: null,
      browserUnavailableReason: "Playwright not installed",
    });
    expect(r.status).toBe("unverified");
    expect(r.gaps).toEqual([{ group: "render", reason: "Playwright not installed" }]);
  });

  it("a private target is not contacted and is unverified, not down", async () => {
    const r = await runPulse({
      url: "http://169.254.169.254/latest/meta-data/",
      policy: defaultPolicy(),
      browser,
    });
    expect(r.status).toBe("unverified");
    expect(r.findings).toEqual([]);
    expect(r.gaps[0]?.reason).toMatch(/non-public address/);
  });

  it("render failures inside a browser never reach the network outside the policy", async () => {
    // localhost-leak's request to localhost:4000 is recorded, never sent.
    const r = await pulse(h.targets.apps["localhost-leak"]?.url ?? "");
    const ev = r.evidence.find(
      (e) => e.kind === "browser_request" && e.locator === "http://localhost:4000/data",
    );
    expect(ev?.payload.not_sent).toBe("loopback address");
    expect(ev?.payload.status).toBeNull();
  });
});

describe("platform adapters", () => {
  const id = (url: string, headers: Record<string, string> = {}) =>
    detectPlatform(new URL(url), headers).identity;
  it("detects Vercel production and preview URLs", () => {
    expect(id("https://shop.vercel.app/")).toMatchObject({
      name: "vercel",
      environment: "production",
    });
    expect(id("https://shop-git-feature-x-acme.vercel.app/")).toMatchObject({
      name: "vercel",
      environment: "preview",
    });
    expect(id("https://shop-a1b2c3d4e-acme.vercel.app/")).toMatchObject({
      name: "vercel",
      environment: "preview",
    });
    expect(id("https://shop.example.com/", { "x-vercel-id": "iad1::abc" })).toMatchObject({
      name: "vercel",
      environment: "unknown",
    });
  });
  it("detects Netlify, Render, Cloudflare Pages and Fly", () => {
    expect(id("https://deploy-preview-12--shop.netlify.app/")).toMatchObject({
      name: "netlify",
      environment: "preview",
    });
    expect(id("https://shop.netlify.app/")).toMatchObject({
      name: "netlify",
      environment: "production",
    });
    expect(id("https://api-pr-7.onrender.com/")).toMatchObject({
      name: "render",
      environment: "preview",
    });
    expect(id("https://x.example.com/", { "rndr-id": "abc" })).toMatchObject({ name: "render" });
    expect(id("https://a1b2c3.shop.pages.dev/")).toMatchObject({
      name: "cloudflare-pages",
      environment: "preview",
    });
    expect(id("https://shop.pages.dev/")).toMatchObject({
      name: "cloudflare-pages",
      environment: "production",
    });
    expect(id("https://shop.fly.dev/")).toMatchObject({ name: "fly", environment: "production" });
    expect(id("https://shop.example.com/", { server: "nginx" })).toMatchObject({
      name: "generic",
      environment: "unknown",
    });
  });
  it("recognises platform access walls", () => {
    const v = detectPlatform(new URL("https://shop-git-x-acme.vercel.app/"), { server: "Vercel" });
    expect(
      v.adapter.isAccessProtected(
        401,
        { server: "Vercel" },
        new URL("https://shop-git-x-acme.vercel.app/"),
      ),
    ).toBe(true);
    expect(
      v.adapter.isAccessProtected(200, { server: "Vercel" }, new URL("https://shop.vercel.app/")),
    ).toBe(false);
    const c = detectPlatform(new URL("https://shop.pages.dev/"), {});
    expect(
      c.adapter.isAccessProtected(
        302,
        {},
        new URL("https://acme.cloudflareaccess.com/cdn-cgi/access/login"),
      ),
    ).toBe(true);
  });
  it("gives a config hint for every topic on every platform", async () => {
    const { ADAPTERS } = await import("./platforms/index.js");
    for (const a of ADAPTERS) {
      for (const t of [
        "env_var",
        "access_protection",
        "production_domain",
        "redirects",
        "headers",
      ] as const) {
        expect(a.configHint(t).length, `${a.name} ${t}`).toBeGreaterThan(20);
      }
    }
  });
});

describe("helpers", () => {
  it("finds unset values in URL paths", () => {
    expect(undefinedTokenIn("https://x.dev/undefined/api/ping")).toBe("undefined");
    expect(undefinedTokenIn("https://x.dev/api/null/items")).toBe("null");
    expect(undefinedTokenIn("https://x.dev/a/%5Bobject%20Object%5D/b")).toBe("[object Object]");
    expect(undefinedTokenIn("https://x.dev/NaN")).toBe("NaN");
    expect(undefinedTokenIn("https://x.dev/api/undefinedness")).toBeNull();
    expect(undefinedTokenIn("https://x.dev/?q=undefined")).toBeNull();
  });
  it("recognises loopback hosts", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "[::1]",
      "0.0.0.0",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    expect(isLoopbackHost("example.com")).toBe(false);
  });
  it("extracts same-origin links from HTML", () => {
    const html =
      '<a href="/about">a</a><a href="https://other.dev/x">b</a><a href="#top">c</a><a href="pricing">d</a>';
    expect(linksFromHtml(html, "https://shop.dev/")).toEqual([
      "https://shop.dev/about",
      "https://shop.dev/pricing",
    ]);
  });
});

describe("draftIssues", () => {
  it("merges env-undefined's two findings into one issue led by UNDEFINED_IN_URL, with a prompt", async () => {
    const { draftIssues } = await import("./issues.js");
    const target = h.targets.apps["env-undefined"]?.url ?? "";
    const r = await pulse(target);
    const drafts = draftIssues(r.findings, r.evidence, {
      target: { url: target, environment: "production" },
      project: { name: "env-undefined", repoUrl: null },
      platform: r.platform,
      lastSuccessfulCheck: null,
      scanSummary: null,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.code).toBe("UNDEFINED_IN_URL");
    expect(drafts[0]?.corroboratingCodes).toEqual(["SAME_ORIGIN_FAILURE"]);
    expect(drafts[0]?.prompt.type).toBe("investigate");
    expect(drafts[0]?.prompt.body).toContain('git grep -n -F "/api/ping"');
    expect(drafts[0]?.recheck).toMatchObject({ module: "pulse", check_group: "render" });
  });

  it("gives every issue on every fixture a prompt (Rule 4)", async () => {
    const { draftIssues } = await import("./issues.js");
    for (const app of loadFixtureApps()) {
      const url = h.targets.apps[app.manifest.name]?.url ?? "";
      const r = await pulse(url);
      const drafts = draftIssues(r.findings, r.evidence, {
        target: { url, environment: null },
        project: null,
        platform: r.platform,
        lastSuccessfulCheck: null,
        scanSummary: null,
      });
      expect(drafts.length, app.manifest.name).toBe(app.manifest.name === "healthy" ? 0 : 1);
      for (const d of drafts) expect(d.prompt.body.length).toBeGreaterThan(200);
    }
  });
});
