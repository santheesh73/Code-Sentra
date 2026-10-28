import type { MainUrlOutcome } from "@codesentra/core";
import { type Hop, SafeFetchError, type SafeResponse, safeFetch } from "@codesentra/ssrf";
import type { Recorder } from "./recorder.js";
import type { PulseOptions } from "./types.js";

export interface ReachabilityResult {
  main: MainUrlOutcome;
  response: SafeResponse | null;
}

const KEEP_HEADERS = [
  "server",
  "content-type",
  "cache-control",
  "location",
  "x-vercel-id",
  "x-vercel-cache",
  "x-nf-request-id",
  "rndr-id",
  "x-render-origin-server",
  "fly-request-id",
  "cf-ray",
  "www-authenticate",
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
];

export function pickHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP_HEADERS) if (h[k] !== undefined) out[k] = h[k].slice(0, 500);
  return out;
}

const hopJson = (h: Hop) => ({
  url: h.url,
  ip: h.ip,
  status: h.status,
  location: h.location,
  ttfb_ms: h.timings.ttfbMs,
});

/** Section 9.1: DNS, TLS, status, full redirect chain, TTFB and total time, headers. */
export async function checkReachability(
  opts: PulseOptions,
  rec: Recorder,
): Promise<ReachabilityResult> {
  const url = opts.url;
  try {
    const res = await safeFetch(url, {
      policy: opts.policy,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBodyBytes: 1024 * 1024,
      headers: opts.bypass ? { [opts.bypass.header]: opts.bypass.value } : {},
    });
    const host = new URL(res.hops[0]?.url ?? url).hostname;
    rec.addEvidence("dns_result", host, {
      host,
      address: res.hops[0]?.ip ?? res.ip,
      dns_ms: res.timings.dnsMs,
    });
    const chainKey = rec.addEvidence("redirect_chain", url, { hops: res.hops.map(hopJson) });
    const respKey = rec.addEvidence("http_response", res.url, {
      url: res.url,
      status: res.status,
      headers: pickHeaders(res.headers),
      ttfb_ms: res.timings.ttfbMs,
      total_ms: res.timings.totalMs,
      body_bytes: res.body.length,
      truncated: res.truncated,
    });
    if (res.tls) {
      // A certificate belongs to the endpoint (host and port), not the host name alone.
      const endpoint = new URL(res.url).host;
      const tlsKey = rec.addEvidence("tls_certificate", endpoint, {
        authorized: res.tls.authorized,
        subject: res.tls.subject,
        issuer: res.tls.issuer,
        valid_from: res.tls.validFrom,
        valid_to: res.tls.validTo,
        days_remaining: res.tls.daysRemaining,
        protocol: res.tls.protocol,
      });
      if (res.tls.daysRemaining !== null && res.tls.daysRemaining < 14) {
        rec.addFinding(
          "TLS_EXPIRING",
          tlsKey,
          `https://${endpoint}/`,
          `The TLS certificate expires in ${res.tls.daysRemaining} days (${res.tls.validTo}).`,
        );
      }
    }
    const redirects = res.hops.length - 1;
    if (redirects > 3) {
      rec.addFinding(
        "LONG_REDIRECT_CHAIN",
        chainKey,
        url,
        `${redirects} redirects before the final page (more than 3).`,
      );
    }
    const threshold = opts.slowThresholdMs ?? 3000;
    if (res.timings.ttfbMs > threshold) {
      rec.addFinding(
        "SLOW_RESPONSE",
        respKey,
        res.url,
        `Time to first byte was ${res.timings.ttfbMs} ms (threshold ${threshold} ms).`,
      );
    }
    if (res.status >= 500) {
      rec.addFinding("SERVER_ERROR", respKey, res.url, `The main URL returned HTTP ${res.status}.`);
    }
    return { main: { reachable: true, status: res.status }, response: res };
  } catch (e) {
    if (!(e instanceof SafeFetchError)) throw e;
    const key = rec.addEvidence("http_response", url, {
      url,
      error: e.code,
      message: e.message,
      hops: e.hops.map(hopJson),
      ...(e.tls
        ? {
            tls: {
              authorized: e.tls.authorized,
              error: e.tls.error,
              subject: e.tls.subject,
              issuer: e.tls.issuer,
              valid_to: e.tls.validTo,
              days_remaining: e.tls.daysRemaining,
            },
          }
        : {}),
    });
    switch (e.code) {
      case "dns_failure":
        rec.addFinding("DNS_FAILURE", key, url, e.message);
        return { main: { reachable: false, failure: "dns" }, response: null };
      case "tls_invalid":
        rec.addFinding("TLS_INVALID", key, url, e.message);
        return { main: { reachable: false, failure: "tls_invalid" }, response: null };
      case "timeout":
        rec.addFinding("TIMEOUT", key, url, `No response within ${opts.timeoutMs ?? 15_000} ms.`);
        return { main: { reachable: false, failure: "timeout" }, response: null };
      case "redirect_loop":
        rec.addFinding("REDIRECT_LOOP", key, url, e.message);
        return { main: { reachable: false, failure: "redirect_loop" }, response: null };
      case "too_many_redirects":
        rec.addFinding("REDIRECT_LOOP", key, url, e.message);
        return { main: { reachable: false, failure: "too_many_redirects" }, response: null };
      case "blocked_address":
      case "invalid_url":
        // Not contacted; reported as a gap, not as an outage.
        return { main: { reachable: false, failure: "blocked" }, response: null };
      case "connection":
        rec.addFinding("DOWN", key, url, e.message);
        return { main: { reachable: false, failure: "connection" }, response: null };
    }
  }
}
