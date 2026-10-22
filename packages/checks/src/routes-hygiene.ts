import { HostLimiter, SafeFetchError, type SafeResponse, safeFetch } from "@codesentra/ssrf";
import type { Recorder } from "./recorder.js";
import type { PulseOptions } from "./types.js";

export const MAX_ROUTES = 50;

/** Same-origin `<a href>` targets from raw HTML, for when the browser did not run. */
export function linksFromHtml(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    try {
      const u = new URL(m[1] as string, base);
      u.hash = "";
      if (u.origin === origin && u.href !== new URL(base).href) out.add(u.href);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/**
 * Section 9.4 (with ADR 0005): GET each same-origin link found on the page and each
 * route from Scan. Max 50, concurrency 4, GET only, never forms.
 */
export async function checkRoutes(
  pageUrl: string,
  links: string[],
  opts: PulseOptions,
  rec: Recorder,
): Promise<{ probed: number }> {
  const origin = new URL(pageUrl).origin;
  const targets = new Set(links);
  for (const route of opts.scanRoutes ?? []) {
    if (/[:[{*]/.test(route)) continue; // parameterised routes are never guessed
    try {
      const u = new URL(route, origin);
      if (u.origin === origin) targets.add(u.href);
    } catch {
      /* ignore */
    }
  }
  const list = [...targets].slice(0, MAX_ROUTES);
  const limiter = new HostLimiter(4, 25);
  const results = await Promise.all(
    list.map((url) =>
      limiter.run(new URL(url).host, async () => {
        try {
          const res = await safeFetch(url, {
            policy: opts.policy,
            timeoutMs: opts.timeoutMs ?? 15_000,
            maxBodyBytes: 64 * 1024,
            headers: opts.bypass ? { [opts.bypass.header]: opts.bypass.value } : {},
          });
          return { url, status: res.status, error: null as string | null, finalUrl: res.url };
        } catch (e) {
          return {
            url,
            status: null,
            error: e instanceof SafeFetchError ? `${e.code}: ${e.message}` : (e as Error).message,
            finalUrl: null,
          };
        }
      }),
    ),
  );
  rec.addEvidence("http_response", `${origin}/#routes`, {
    probed: results.map((r) => ({
      url: r.url,
      status: r.status,
      error: r.error,
      final_url: r.finalUrl,
    })),
    truncated_to: list.length < targets.size ? MAX_ROUTES : null,
  });
  for (const r of results) {
    if (r.status !== null && r.status < 400) continue;
    const routeKey = rec.addEvidence("http_response", r.url, {
      url: r.url,
      status: r.status,
      error: r.error,
      probe: "route",
    });
    rec.addFinding(
      "ROUTE_BROKEN",
      routeKey,
      r.url,
      r.status !== null
        ? `GET ${new URL(r.url).pathname} returned HTTP ${r.status}.`
        : `GET ${new URL(r.url).pathname} failed: ${r.error}`,
    );
  }
  return { probed: list.length };
}

/** Section 9.5: security headers, mixed content (render), robots.txt / sitemap (info only). */
export async function checkHygiene(
  main: SafeResponse,
  opts: PulseOptions,
  rec: Recorder,
): Promise<void> {
  const h = main.headers;
  const https = new URL(main.url).protocol === "https:";
  const csp = h["content-security-policy"] ?? null;
  const present = {
    "content-security-policy": csp !== null,
    "x-content-type-options": (h["x-content-type-options"] ?? "").toLowerCase() === "nosniff",
    "frame-protection": h["x-frame-options"] !== undefined || /frame-ancestors/i.test(csp ?? ""),
    "strict-transport-security": https ? h["strict-transport-security"] !== undefined : null,
  };
  const key = rec.addEvidence("security_headers", main.url, {
    url: main.url,
    https,
    present,
    values: {
      "content-security-policy": csp?.slice(0, 500) ?? null,
      "x-content-type-options": h["x-content-type-options"] ?? null,
      "x-frame-options": h["x-frame-options"] ?? null,
      "strict-transport-security": h["strict-transport-security"] ?? null,
    },
  });
  const missing: [string, string][] = [];
  if (!present["content-security-policy"])
    missing.push([
      "Content-Security-Policy",
      "limits which scripts and resources the page may load",
    ]);
  if (!present["x-content-type-options"])
    missing.push(["X-Content-Type-Options: nosniff", "stops browsers guessing content types"]);
  if (!present["frame-protection"])
    missing.push(["X-Frame-Options or CSP frame-ancestors", "prevents clickjacking via framing"]);
  if (present["strict-transport-security"] === false)
    missing.push(["Strict-Transport-Security", "keeps browsers on HTTPS"]);
  for (const [name, why] of missing) {
    rec.addFinding("MISSING_SECURITY_HEADER", key, main.url, `Missing ${name} (${why}).`, name);
  }

  const origin = new URL(main.url).origin;
  const probe = async (path: string) => {
    try {
      const r = await safeFetch(`${origin}${path}`, {
        policy: opts.policy,
        timeoutMs: 5000,
        maxBodyBytes: 8 * 1024,
      });
      return r.status;
    } catch {
      return null;
    }
  };
  const [robots, sitemap] = await Promise.all([probe("/robots.txt"), probe("/sitemap.xml")]);
  rec.addEvidence("http_response", `${origin}/robots.txt`, {
    info_only: true,
    robots_txt: robots,
    sitemap_xml: sitemap,
  });
}
