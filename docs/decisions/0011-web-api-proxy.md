# 0011 — The web app proxies `/api/*` to the API

- **Status:** accepted (Phase 1)

## Context

Production runs the web app on Vercel and the API on Render or Fly (Section 18, Phase 5).
Calling the API cross-site from the browser would make the session cookie third-party,
which browsers increasingly block, and would need credentialed CORS.

## Decision

`apps/web/app/api/[...path]/route.ts` proxies every `/api/*` request to
`API_INTERNAL_URL`:
- request and response bodies are streamed, so the SSE run stream works end to end
  (`compress: false` in Next, because Node-level gzip would buffer it);
- redirects pass through untouched (GitHub OAuth);
- an allowlist of headers crosses in each direction; `Set-Cookie` is forwarded;
- path segments like `..` are refused.

The browser only ever talks to `PUBLIC_APP_URL`, so the session cookie is first-party,
SameSite=Lax holds, and the API's Origin check compares against that one origin. The
GitHub OAuth callback is `${PUBLIC_APP_URL}/api/v1/auth/github/callback`.

## Consequences

One extra hop per API call. Server components read the session cookie and call the API
directly on `API_INTERNAL_URL`.
