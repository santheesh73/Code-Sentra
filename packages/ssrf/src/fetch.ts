import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction, Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { checkAddress, isIpLiteral } from "./address.js";
import type { FetchPolicy, ResolvedAddress } from "./policy.js";

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "dns_failure"
  | "tls_invalid"
  | "timeout"
  | "connection"
  | "too_many_redirects"
  | "redirect_loop";

export interface TlsInfo {
  authorized: boolean;
  error: string | null;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** Days until expiry, negative when expired. */
  daysRemaining: number | null;
  protocol: string | null;
}

export interface Hop {
  url: string;
  ip: string;
  status: number;
  headers: Record<string, string>;
  location: string | null;
  tls: TlsInfo | null;
  timings: { dnsMs: number; ttfbMs: number; totalMs: number };
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  /** Every response received, in order, including redirects. */
  hops: Hop[];
  tls: TlsInfo | null;
  ip: string;
  timings: { dnsMs: number; ttfbMs: number; totalMs: number };
}

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly url: string,
    readonly hops: Hop[] = [],
    readonly tls: TlsInfo | null = null,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  policy: FetchPolicy;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  /** Per-hop timeout. Default 15 s. */
  timeoutMs?: number;
  /** Default 10 (Section 9). */
  maxRedirects?: number;
  followRedirects?: boolean;
  /** Body is read up to this many bytes, then marked truncated. Default 2 MiB. */
  maxBodyBytes?: number;
  signal?: AbortSignal;
}

/** Header names never stored or forwarded. */
const DROP_HEADERS = new Set(["set-cookie", "authorization", "proxy-authorization", "cookie"]);

function flattenHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || DROP_HEADERS.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function parseTarget(raw: string | URL): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "not a valid URL", String(raw));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SafeFetchError("invalid_url", `scheme ${u.protocol} is not allowed`, u.href);
  }
  if (u.username || u.password) {
    throw new SafeFetchError("invalid_url", "URLs with credentials are not allowed", u.href);
  }
  return u;
}

const bareHost = (u: URL) =>
  u.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();

/** RFC 6761: these names always mean loopback, whatever a resolver says. */
const isLocalhostName = (host: string) => host === "localhost" || host.endsWith(".localhost");

/**
 * Resolves a URL's host once and checks every address. Returns the checked addresses
 * to pin, in resolver order; the socket may try each of them and nothing else.
 * Any blocked address fails the whole host: a name that resolves to both a public and
 * a private address is treated as hostile (DNS rebinding).
 */
export async function resolveTarget(
  raw: string | URL,
  policy: FetchPolicy,
): Promise<ResolvedAddress[]> {
  const u = parseTarget(raw);
  const host = bareHost(u);
  const exempt = policy.allowHosts.has(host);
  if (!exempt && isLocalhostName(host)) {
    throw new SafeFetchError(
      "blocked_address",
      `refused to connect to ${host}: a loopback name`,
      u.href,
    );
  }
  let addresses: ResolvedAddress[];
  if (isIpLiteral(host)) {
    addresses = [{ address: host, family: host.includes(":") ? 6 : 4 }];
  } else {
    try {
      addresses = await policy.resolver(host);
    } catch (e) {
      throw new SafeFetchError(
        "dns_failure",
        `DNS lookup failed for ${host}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
        u.href,
      );
    }
    if (addresses.length === 0)
      throw new SafeFetchError("dns_failure", `${host} has no addresses`, u.href);
  }
  if (!exempt) {
    for (const a of addresses) {
      const verdict = checkAddress(a.address);
      if (!verdict.allowed) {
        throw new SafeFetchError(
          "blocked_address",
          `refused to connect to ${host}: ${verdict.reason}`,
          u.href,
        );
      }
    }
  }
  return addresses;
}

function tlsInfo(socket: TLSSocket): TlsInfo {
  const cert = socket.getPeerCertificate();
  const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
  return {
    authorized: socket.authorized,
    error: socket.authorizationError ? String(socket.authorizationError) : null,
    subject: cert?.subject?.CN ? String(cert.subject.CN) : null,
    issuer: cert?.issuer ? String(cert.issuer.O ?? cert.issuer.CN ?? "") || null : null,
    validFrom: cert?.valid_from ? new Date(cert.valid_from).toISOString() : null,
    validTo: validTo ? validTo.toISOString() : null,
    daysRemaining: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null,
    protocol: socket.getProtocol() ?? null,
  };
}

interface HopResult {
  hop: Hop;
  body: Buffer;
  truncated: boolean;
}

async function requestOnce(u: URL, opts: SafeFetchOptions, readBody: boolean): Promise<HopResult> {
  const t0 = performance.now();
  const pinned = await resolveTarget(u, opts.policy);
  const first = pinned[0] as ResolvedAddress;
  const dnsMs = Math.round(performance.now() - t0);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBody = opts.maxBodyBytes ?? 2 * 1024 * 1024;
  const host = bareHost(u);

  const lookup: LookupFunction = (_hostname, options, cb) => {
    if ((options as { all?: boolean }).all) {
      // With autoSelectFamily (Node's default since 20), Node tries these in turn (an unreachable ::1 falls back to
      // 127.0.0.1); all of them were checked, so no address outside the pin is reachable.
      (cb as unknown as (e: null, a: ResolvedAddress[]) => void)(null, pinned);
    } else {
      cb(null, first.address, first.family);
    }
  };

  return new Promise<HopResult>((resolve, reject) => {
    let tls: TlsInfo | null = null;
    let settled = false;
    const fail = (e: SafeFetchError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(e);
    };
    const isHttps = u.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: u.protocol,
        hostname: host,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers: {
          "user-agent": opts.policy.userAgent,
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          ...opts.headers,
        },
        lookup,
        agent: false,
        ...(isHttps
          ? {
              servername: isIpLiteral(host) ? undefined : host,
              rejectUnauthorized: false,
              ca: opts.policy.ca ? [opts.policy.ca] : undefined,
            }
          : {}),
        signal: opts.signal,
      },
      (res) => {
        const ttfbMs = Math.round(performance.now() - t0);
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const headers = flattenHeaders(res);
          resolve({
            hop: {
              url: u.href,
              ip: res.socket?.remoteAddress ?? first.address,
              status: res.statusCode ?? 0,
              headers,
              location: typeof res.headers.location === "string" ? res.headers.location : null,
              tls,
              timings: { dnsMs, ttfbMs, totalMs: Math.round(performance.now() - t0) },
            },
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        if (!readBody) {
          res.resume();
          finish();
          return;
        }
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBody) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBody)));
            finish();
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", finish);
        res.on("error", (e) => fail(new SafeFetchError("connection", e.message, u.href)));
      },
    );
    const timer = setTimeout(
      () =>
        fail(new SafeFetchError("timeout", `no response within ${timeoutMs} ms`, u.href, [], tls)),
      timeoutMs,
    );
    req.on("socket", (socket: Socket) => {
      if (!isHttps) return;
      socket.once("secureConnect", () => {
        tls = tlsInfo(socket as TLSSocket);
        if (!tls.authorized) {
          fail(
            new SafeFetchError(
              "tls_invalid",
              `TLS certificate rejected: ${tls.error}`,
              u.href,
              [],
              tls,
            ),
          );
        }
      });
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      if (e.name === "AbortError")
        return fail(new SafeFetchError("timeout", "aborted", u.href, [], tls));
      const code = e.code ?? "";
      if (
        /^(ERR_TLS|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO|ERR_SSL)/.test(code) ||
        /certificate|SSL/i.test(e.message)
      ) {
        return fail(new SafeFetchError("tls_invalid", e.message, u.href, [], tls));
      }
      fail(new SafeFetchError("connection", `${code || "error"}: ${e.message}`, u.href, [], tls));
    });
    req.end();
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches a URL with SSRF protection: every hop's host is resolved once, checked, and
 * pinned for the connection; redirects are followed manually and re-validated, up to
 * `maxRedirects`. Cookies are never stored or sent.
 */
export async function safeFetch(raw: string | URL, opts: SafeFetchOptions): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 10;
  const follow = opts.followRedirects ?? true;
  const hops: Hop[] = [];
  const seen = new Set<string>();
  let current = parseTarget(raw);
  const start = performance.now();

  for (;;) {
    const key = current.href;
    if (seen.has(key)) {
      throw new SafeFetchError("redirect_loop", `redirect loop at ${key}`, String(raw), hops);
    }
    seen.add(key);
    let result: HopResult;
    try {
      result = await requestOnce(current, opts, true);
    } catch (e) {
      if (e instanceof SafeFetchError)
        throw new SafeFetchError(e.code, e.message, e.url, hops, e.tls);
      throw e;
    }
    hops.push(result.hop);
    const { hop } = result;
    if (follow && REDIRECT.has(hop.status) && hop.location) {
      if (hops.length > maxRedirects) {
        throw new SafeFetchError(
          "too_many_redirects",
          `more than ${maxRedirects} redirects`,
          String(raw),
          hops,
        );
      }
      let next: URL;
      try {
        next = new URL(hop.location, current);
      } catch {
        throw new SafeFetchError(
          "invalid_url",
          `invalid redirect location ${hop.location}`,
          current.href,
          hops,
        );
      }
      current = parseTarget(next);
      continue;
    }
    const first = hops[0] as Hop;
    return {
      url: hop.url,
      status: hop.status,
      headers: hop.headers,
      body: result.body,
      truncated: result.truncated,
      hops,
      tls: hop.tls ?? first.tls,
      ip: hop.ip,
      timings: {
        dnsMs: first.timings.dnsMs,
        ttfbMs: first.timings.ttfbMs,
        totalMs: Math.round(performance.now() - start),
      },
    };
  }
}
