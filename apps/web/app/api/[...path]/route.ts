import { webConfig } from "@/lib/server-api";

/**
 * Same-origin proxy to the API. The browser only ever talks to the web app, so the
 * session cookie is first-party and SameSite=Lax holds. Bodies are streamed both ways
 * (SSE works), redirects are passed through (GitHub OAuth), and only an allowlist of
 * headers crosses in either direction.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "origin",
  "referer",
  "user-agent",
  "last-event-id",
  // API tokens (CLI) and GitHub App webhooks reach the API through this origin too.
  "authorization",
  "x-github-event",
  "x-github-delivery",
  "x-hub-signature-256",
];
const RESPONSE_HEADERS = [
  "content-type",
  "location",
  "cache-control",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

async function proxy(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  if (path.some((seg) => seg === ".." || seg.includes("\\"))) {
    return new Response(null, { status: 400 });
  }
  const incoming = new URL(req.url);
  const target = new URL(
    `/${path.map(encodeURIComponent).join("/")}`,
    webConfig().API_INTERNAL_URL,
  );
  target.search = incoming.search;

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    cache: "no-store",
    signal: req.signal,
    // Required by Node fetch when streaming a request body.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append("set-cookie", c);
  if (upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
