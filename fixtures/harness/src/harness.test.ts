import { type PeerCertificate, connect as tlsConnect } from "node:tls";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, SIMULATORS, startHarness } from "./harness.js";
import { loadFixtureApps } from "./manifest.js";
import { compare, launchChromium, observe } from "./self-test.js";

let harness: Harness;
const SLOW_MS = 400;

beforeAll(async () => {
  harness = await startHarness({ slowMs: SLOW_MS });
});
afterAll(async () => {
  await harness?.close();
});

async function get(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { redirect: "manual", ...init });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

function tlsProbe(
  url: string,
  ca?: string,
): Promise<{ authorized: boolean; error?: string; cert: PeerCertificate }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: "127.0.0.1",
        servername: u.hostname,
        port: Number(u.port),
        ca,
        rejectUnauthorized: false,
      },
      () => {
        const out = {
          authorized: socket.authorized,
          error: socket.authorizationError ? String(socket.authorizationError) : undefined,
          cert: socket.getPeerCertificate(),
        };
        socket.end();
        resolve(out);
      },
    );
    socket.on("error", reject);
  });
}

describe("harness serves every fixture app", () => {
  it("lists every app and simulator", () => {
    expect(Object.keys(harness.targets.apps).sort()).toEqual(
      loadFixtureApps().map((a) => a.manifest.name),
    );
    expect(Object.keys(harness.targets.simulators).sort()).toEqual([...SIMULATORS].sort());
  });

  it("serves each app's index with security headers", async () => {
    for (const [name, t] of Object.entries(harness.targets.apps)) {
      const r = await get(t.url);
      expect(r.status, name).toBe(200);
      expect(r.headers.get("content-type"), name).toContain("text/html");
      expect(r.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(r.headers.get("content-security-policy"), name).toBeTruthy();
      expect(r.headers.get("strict-transport-security"), name).toBeTruthy();
    }
  });

  it("returns 404 for unknown routes", async () => {
    const r = await get(new URL("/pricing", harness.targets.apps["broken-route"]?.url).href);
    expect(r.status).toBe(404);
  });

  it("switches env-undefined variants through the control endpoint", async () => {
    const app = harness.targets.apps["env-undefined"];
    if (!app) throw new Error("env-undefined missing");
    const brokenHtml = (await get(app.url)).body;
    const res = await fetch(
      new URL("/__harness/apps/env-undefined/variant", harness.targets.control),
      {
        method: "POST",
        body: JSON.stringify({ variant: "fixed" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { variant: string }).variant).toBe("fixed");
    const fixedHtml = (await get(app.url)).body;
    expect(fixedHtml).not.toBe(brokenHtml);
    expect((await get(new URL("/backend/api/ping", app.url).href)).status).toBe(200);
    harness.setVariant("env-undefined", "broken");
    expect((await get(app.url)).body).toBe(brokenHtml);
  });

  it("rejects unknown variants", async () => {
    const res = await fetch(new URL("/__harness/apps/healthy/variant", harness.targets.control), {
      method: "POST",
      body: JSON.stringify({ variant: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("simulators", () => {
  const s = () => harness.targets.simulators;

  it("server-error and service-unavailable return 5xx", async () => {
    expect((await get(s()["server-error"].url)).status).toBe(500);
    expect((await get(s()["service-unavailable"].url)).status).toBe(503);
  });

  it("not-found returns 404", async () => {
    expect((await get(s()["not-found"].url)).status).toBe(404);
  });

  it("access-protected answers 401 from Vercel's edge", async () => {
    const res = await get(s()["access-protected"].url);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-vercel-id")).toBeTruthy();
  });

  it("preview-deployment serves a page as Vercel", async () => {
    const res = await get(s()["preview-deployment"].url);
    expect(res.status).toBe(200);
    expect(res.headers.get("server")).toBe("Vercel");
  });

  it("timeout never answers", async () => {
    await expect(get(s().timeout.url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });

  it("slow delays the first byte", async () => {
    const t0 = performance.now();
    expect((await get(s().slow.url)).status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(SLOW_MS - 20);
  });

  it("redirect-loop loops", async () => {
    const base = s()["redirect-loop"].url;
    const seen: string[] = [];
    let url = base;
    for (let i = 0; i < 6; i++) {
      const r = await get(url);
      expect(r.status).toBe(302);
      const next = new URL(r.headers.get("location") ?? "", url).href;
      seen.push(new URL(next).pathname);
      url = next;
    }
    expect(new Set(seen)).toEqual(new Set(["/loop-a", "/loop-b"]));
  });

  it("long-redirect-chain takes 5 hops to a 200", async () => {
    let url = s()["long-redirect-chain"].url;
    let hops = 0;
    for (;;) {
      const r = await get(url);
      if (r.status !== 301) {
        expect(r.status).toBe(200);
        break;
      }
      hops++;
      url = new URL(r.headers.get("location") ?? "", url).href;
      expect(hops).toBeLessThan(10);
    }
    expect(hops).toBe(5);
  });

  it("connection-refused refuses", async () => {
    await expect(get(s()["connection-refused"].url)).rejects.toThrow();
  });

  it("dns-failure uses a name that cannot resolve", async () => {
    expect(new URL(s()["dns-failure"].url).hostname.endsWith(".invalid")).toBe(true);
  });

  it("tls-valid is trusted only with the harness CA", async () => {
    const withCa = await tlsProbe(s()["tls-valid"].url, harness.caCertPem);
    expect(withCa.authorized).toBe(true);
    const withoutCa = await tlsProbe(s()["tls-valid"].url);
    expect(withoutCa.authorized).toBe(false);
  });

  it("tls-expiring is valid and expires within 14 days", async () => {
    const r = await tlsProbe(s()["tls-expiring"].url, harness.caCertPem);
    expect(r.authorized).toBe(true);
    const daysLeft = (new Date(r.cert.valid_to).getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(0);
    expect(daysLeft).toBeLessThan(14);
  });

  it("tls-expired, tls-wrong-host and tls-self-signed fail verification", async () => {
    const expired = await tlsProbe(s()["tls-expired"].url, harness.caCertPem);
    expect(expired.authorized).toBe(false);
    expect(expired.error).toMatch(/CERT_HAS_EXPIRED/);

    const selfSigned = await tlsProbe(s()["tls-self-signed"].url, harness.caCertPem);
    expect(selfSigned.authorized).toBe(false);
    expect(selfSigned.error).toMatch(/SELF_SIGNED/);

    const wrongHost = await tlsProbe(s()["tls-wrong-host"].url, harness.caCertPem);
    expect(wrongHost.authorized).toBe(false);
    expect(wrongHost.error).toMatch(/ALTNAME|Hostname/i);
    expect(wrongHost.cert.subject.CN).toBe("not-this-host.example");
  });
});

describe("fixture apps behave as documented in a real browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    // Deliberately no skip: if Chromium is missing this gate fails (Rule 2).
    browser = await launchChromium();
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const app of loadFixtureApps()) {
    for (const variant of Object.keys(app.manifest.variants)) {
      it(`${app.manifest.name} (${variant})`, async () => {
        const target = harness.targets.apps[app.manifest.name];
        if (!target) throw new Error(`${app.manifest.name} not served`);
        harness.setVariant(app.manifest.name, variant);
        try {
          const spec = app.manifest.selfTest[variant];
          if (!spec) throw new Error(`no selfTest for ${variant}`);
          const obs = await observe(browser, target.url, spec.requests);
          expect(compare(spec, obs, target.url)).toEqual([]);
        } finally {
          harness.setVariant(app.manifest.name, app.manifest.defaultVariant);
        }
      });
    }
  }
});
