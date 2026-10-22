import { HostLimiter, SafeFetchError, safeFetch } from "@codesentra/ssrf";
import type { Browser, Route } from "playwright-core";
import type { Recorder } from "./recorder.js";
import type { PulseOptions } from "./types.js";

export interface RenderOutcome {
  ran: boolean;
  gapReason?: string;
  /** Same-origin links found on the rendered page (absolute URLs, no fragment). */
  links: string[];
  screenshot: Buffer | null;
}

interface TrackedRequest {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  error: string | null;
  notSent: string | null;
  /** The main frame's own document (reported by reachability as BAD_STATUS, not here). */
  mainDocument: boolean;
}

const UNDEFINED_TOKENS = new Set(["undefined", "null", "[object object]", "nan"]);
const LOOPBACK_HOST = /^(localhost|.*\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
/** Hop-by-hop or transformed headers we must not replay to the browser. */
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
  "keep-alive",
]);

/** The path segment that holds an unset value, e.g. `/undefined/api/ping` → "undefined". */
export function undefinedTokenIn(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  for (const seg of path.split("/")) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    if (UNDEFINED_TOKENS.has(decoded.toLowerCase())) return decoded;
  }
  return null;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOST.test(hostname.replace(/\.$/, ""));
}

const fulfillHeaders = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !DROP_RESPONSE_HEADERS.has(k)));

/**
 * Section 9.3: Chromium, fresh context, 1366×768, networkidle capped at 15 s. Every
 * request is fulfilled by the SSRF-safe fetch (Chromium never connects on its own), only
 * GET/HEAD leave the page, and loopback calls are recorded and never made.
 */
export async function checkRender(
  browser: Browser,
  pageUrl: string,
  opts: PulseOptions,
  rec: Recorder,
): Promise<RenderOutcome> {
  const page0 = new URL(pageUrl);
  const limiter = new HostLimiter(6, 0);
  const tracked: TrackedRequest[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    serviceWorkers: "block",
    acceptDownloads: false,
    bypassCSP: false,
  });
  try {
    await context.route("**/*", async (route: Route) => {
      const req = route.request();
      const entry: TrackedRequest = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: null,
        error: null,
        notSent: null,
        mainDocument: req.isNavigationRequest() && req.frame().parentFrame() === null,
      };
      tracked.push(entry);
      let u: URL;
      try {
        u = new URL(entry.url);
      } catch {
        entry.notSent = "invalid URL";
        return route.abort("failed");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        entry.notSent = `scheme ${u.protocol}`;
        return route.abort("blockedbyclient");
      }
      if (isLoopbackHost(u.hostname) && u.origin !== page0.origin) {
        entry.notSent = "loopback address";
        return route.abort("blockedbyclient");
      }
      if (entry.method !== "GET" && entry.method !== "HEAD") {
        entry.notSent = `CodeSentra only sends GET and HEAD (page attempted ${entry.method})`;
        return route.abort("blockedbyclient");
      }
      try {
        const sameOrigin = u.origin === page0.origin;
        const res = await limiter.run(u.host, () =>
          safeFetch(u, {
            policy: opts.policy,
            method: entry.method as "GET" | "HEAD",
            followRedirects: false,
            timeoutMs: 10_000,
            maxBodyBytes: 15 * 1024 * 1024,
            headers: {
              accept: req.headers().accept ?? "*/*",
              ...(sameOrigin && opts.bypass ? { [opts.bypass.header]: opts.bypass.value } : {}),
            },
          }),
        );
        entry.status = res.status;
        await route.fulfill({
          status: res.status,
          headers: fulfillHeaders(res.headers),
          body: res.body,
        });
      } catch (e) {
        const err = e instanceof SafeFetchError ? e : null;
        entry.error = err ? `${err.code}: ${err.message}` : (e as Error).message;
        await route
          .abort(
            err?.code === "timeout"
              ? "timedout"
              : err?.code === "blocked_address"
                ? "blockedbyclient"
                : "failed",
          )
          .catch(() => {});
      }
    });

    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    let idle = true;
    try {
      await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 15_000 });
    } catch (e) {
      if (!/Timeout/i.test((e as Error).message)) {
        return {
          ran: false,
          gapReason: `the browser could not load the page: ${(e as Error).message.split("\n")[0]}`,
          links: [],
          screenshot: null,
        };
      }
      idle = false;
    }
    // Let zero-delay timers and late fetches settle before reading the page.
    await page.waitForTimeout(500);

    const summary = (await page.evaluate(() => {
      const body = document.body;
      // innerText: what a user can see (textContent would include hidden nodes).
      const text = body?.innerText.trim() ?? "";
      const media = body ? body.querySelectorAll("img, svg, canvas, video, iframe").length : 0;
      const links = [...document.querySelectorAll("a[href]")].map(
        (a) => (a as HTMLAnchorElement).href,
      );
      return { textLength: text.length, media, links, title: document.title };
    })) as { textLength: number; media: number; links: string[]; title: string };
    const finalPage = new URL(page.url());
    const screenshot = await page.screenshot({ type: "png" }).catch(() => null);

    const summaryKey = rec.addEvidence("render_summary", finalPage.href, {
      title: summary.title.slice(0, 200),
      text_length: summary.textLength,
      media_elements: summary.media,
      network_idle: idle,
      requests: tracked.length,
      console_errors: consoleErrors.length,
      page_errors: pageErrors.length,
    });

    for (const r of tracked) {
      let u: URL;
      try {
        u = new URL(r.url);
      } catch {
        continue;
      }
      const notable =
        r.notSent !== null ||
        r.error !== null ||
        (r.status !== null && r.status >= 400) ||
        undefinedTokenIn(r.url) !== null ||
        (finalPage.protocol === "https:" && u.protocol === "http:");
      if (!notable) continue;
      const key = rec.addEvidence("browser_request", r.url, {
        url: r.url,
        method: r.method,
        resource_type: r.resourceType,
        status: r.status,
        error: r.error,
        not_sent: r.notSent,
        page: finalPage.href,
      });
      const token = undefinedTokenIn(r.url);
      if (token) {
        rec.addFinding(
          "UNDEFINED_IN_URL",
          key,
          r.url,
          `The page requested ${r.url}: the path contains "${token}", so a value (often an environment variable) was unset when the URL was built.`,
        );
      }
      if (r.notSent === "loopback address") {
        rec.addFinding(
          "LOCALHOST_CALL",
          key,
          `${u.protocol}//${u.host}${u.pathname}`,
          `The page tries to call ${u.protocol}//${u.host}${u.pathname}, which only exists on a developer machine.`,
        );
      }
      if (
        u.origin === finalPage.origin &&
        r.status !== null &&
        r.status >= 400 &&
        !r.mainDocument
      ) {
        rec.addFinding(
          "SAME_ORIGIN_FAILURE",
          key,
          r.url,
          `Same-origin ${r.method} ${u.pathname} returned HTTP ${r.status}.`,
        );
      }
      if (finalPage.protocol === "https:" && u.protocol === "http:") {
        rec.addFinding(
          "MIXED_CONTENT",
          key,
          r.url,
          `The HTTPS page loads ${r.url} over plain HTTP.`,
        );
      }
    }

    for (const message of pageErrors) {
      const key = rec.addEvidence("page_error", finalPage.href, {
        message: message.slice(0, 2000),
        page: finalPage.href,
      });
      rec.addFinding(
        "UNCAUGHT_EXCEPTION",
        key,
        finalPage.href,
        `Uncaught exception on load: ${message.slice(0, 300)}`,
        message.slice(0, 2000),
      );
    }
    for (const text of consoleErrors) {
      // Failed resource loads are already reported, with their URL, as request findings.
      if (/^Failed to load resource/i.test(text)) continue;
      const key = rec.addEvidence("console_message", finalPage.href, {
        level: "error",
        text: text.slice(0, 2000),
        page: finalPage.href,
      });
      rec.addFinding(
        "CONSOLE_ERROR",
        key,
        finalPage.href,
        `Console error: ${text.slice(0, 300)}`,
        text.slice(0, 2000),
      );
    }
    if (summary.textLength === 0 && summary.media === 0) {
      rec.addFinding(
        "BLANK_PAGE",
        summaryKey,
        finalPage.href,
        "The page rendered no visible text or media.",
      );
    }

    const links = new Set<string>();
    for (const href of summary.links) {
      try {
        const l = new URL(href);
        if (l.origin !== finalPage.origin) continue;
        l.hash = "";
        if (l.href !== finalPage.href) links.add(l.href);
      } catch {
        /* ignore malformed */
      }
    }
    if (screenshot)
      rec.addEvidence("screenshot", finalPage.href, {
        format: "png",
        bytes: screenshot.length,
        viewport: "1366x768",
      });
    return { ran: true, links: [...links], screenshot };
  } finally {
    await context.close().catch(() => {});
  }
}
