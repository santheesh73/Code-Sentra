import { existsSync } from "node:fs";
import type { Browser } from "playwright-core";
import type { SelfTestVariant } from "./manifest.js";

export interface ObservedRequest {
  url: string;
  status: number | null;
  failure: string | null;
}

export interface Observation {
  requests: ObservedRequest[];
  consoleErrors: string[];
  pageErrors: string[];
  textLength: number;
  links: { path: string; status: number }[];
}

/**
 * Resolves a Chromium executable. Order: CHROMIUM_EXECUTABLE env, the sandbox's
 * preinstalled /opt/pw-browsers/chromium, else let Playwright use its own install.
 */
export function chromiumExecutable(): string | undefined {
  const fromEnv = process.env.CHROMIUM_EXECUTABLE;
  if (fromEnv) return fromEnv;
  const preinstalled = "/opt/pw-browsers/chromium";
  return existsSync(preinstalled) ? preinstalled : undefined;
}

export async function launchChromium(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const executablePath = chromiumExecutable();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

/** Loads a page in a fresh context and records what a browser actually sees. */
export async function observe(browser: Browser, url: string): Promise<Observation> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const byRequest = new Map<object, ObservedRequest>();
  const obs: Observation = {
    requests: [],
    consoleErrors: [],
    pageErrors: [],
    textLength: 0,
    links: [],
  };

  page.on("request", (r) => {
    const entry = { url: r.url(), status: null, failure: null };
    byRequest.set(r, entry);
    obs.requests.push(entry);
  });
  page.on("response", (r) => {
    const entry = byRequest.get(r.request());
    if (entry) entry.status = r.status();
  });
  page.on("requestfailed", (r) => {
    const entry = byRequest.get(r);
    if (entry) entry.failure = r.failure()?.errorText ?? "failed";
  });
  page.on("console", (m) => {
    if (m.type() === "error") obs.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => obs.pageErrors.push(e.message));

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
  } catch (e) {
    if (!(e instanceof Error) || !/Timeout/i.test(e.message)) throw e;
  }
  // Let zero-delay timers (console-throw) and late fetches settle.
  await page.waitForTimeout(500);

  obs.textLength = (await page.evaluate(
    // biome-ignore lint/performance/useDomNodeTextContent: rendered (visible) text is the point; textContent includes hidden nodes
    () => document.body?.innerText.trim().length ?? 0,
  )) as number;
  const origin = new URL(url).origin;
  const hrefs = (await page.$$eval("a[href]", (as) =>
    as.map((a) => (a as HTMLAnchorElement).href),
  )) as string[];
  const sameOrigin = [...new Set(hrefs.filter((h) => new URL(h).origin === origin))];
  for (const href of sameOrigin) {
    const res = await fetch(href, { method: "GET", redirect: "manual" });
    await res.body?.cancel();
    obs.links.push({ path: new URL(href).pathname, status: res.status });
  }
  await context.close();
  return obs;
}

/** Returns human-readable mismatches between an observation and the fixture's self-test spec. */
export function compare(spec: SelfTestVariant, obs: Observation, baseUrl: string): string[] {
  const problems: string[] = [];
  const origin = new URL(baseUrl).origin;
  const sameOriginPath = (u: string) => {
    const parsed = new URL(u);
    return parsed.origin === origin ? parsed.pathname : null;
  };

  for (const want of spec.requests) {
    const hit = obs.requests.find((r) =>
      "path" in want ? sameOriginPath(r.url) === want.path : r.url === want.url,
    );
    const label = "path" in want ? want.path : want.url;
    if (!hit) {
      problems.push(
        `expected a request to ${label}; saw ${obs.requests.map((r) => r.url).join(", ")}`,
      );
    } else if (want.status !== undefined && hit.status !== want.status) {
      problems.push(`expected ${label} to return ${want.status}, got ${hit.status ?? hit.failure}`);
    }
  }
  for (const forbidden of spec.forbiddenRequestPaths) {
    if (obs.requests.some((r) => sameOriginPath(r.url) === forbidden)) {
      problems.push(`unexpected request to ${forbidden}`);
    }
  }
  for (const want of spec.links) {
    const hit = obs.links.find((l) => l.path === want.path);
    if (!hit) problems.push(`expected a link to ${want.path}`);
    else if (hit.status !== want.status) {
      problems.push(`expected link ${want.path} to return ${want.status}, got ${hit.status}`);
    }
  }
  if (spec.pageErrors.length === 0 && obs.pageErrors.length > 0) {
    problems.push(`unexpected page errors: ${obs.pageErrors.join(" | ")}`);
  }
  for (const want of spec.pageErrors) {
    if (!obs.pageErrors.some((e) => e.includes(want))) {
      problems.push(
        `expected a page error containing ${want}; saw ${obs.pageErrors.join(" | ") || "none"}`,
      );
    }
  }
  if (spec.consoleErrors && spec.consoleErrors.length === 0 && obs.consoleErrors.length > 0) {
    problems.push(`unexpected console errors: ${obs.consoleErrors.join(" | ")}`);
  }
  if (spec.noFailedRequests) {
    const bad = obs.requests.filter((r) => r.failure || (r.status !== null && r.status >= 400));
    if (bad.length > 0) {
      problems.push(
        `unexpected failed requests: ${bad.map((r) => `${r.url} (${r.status ?? r.failure})`).join(", ")}`,
      );
    }
  }
  if (spec.minTextLength !== undefined && obs.textLength < spec.minTextLength) {
    problems.push(
      `expected at least ${spec.minTextLength} characters of text, got ${obs.textLength}`,
    );
  }
  if (spec.maxTextLength !== undefined && obs.textLength > spec.maxTextLength) {
    problems.push(
      `expected at most ${spec.maxTextLength} characters of text, got ${obs.textLength}`,
    );
  }
  return problems;
}
