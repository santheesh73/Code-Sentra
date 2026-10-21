# 0010 — Authentication and sessions

- **Status:** accepted (Phase 1)

## Decision

The Fastify API owns authentication with Lucia-style database sessions. Auth.js was not
used because it is built around Next.js route handlers, while the API (not the web app)
is the system of record that the CLI and the GitHub App also talk to.
- **Sessions:** a 256-bit random token in cookie `cs_session` (HttpOnly, SameSite=Lax,
  Secure on https, Path=/). Only `sha256(token)` is stored. Sessions last 30 days and are
  renewed once half has elapsed. Logout deletes the row.
- **Magic link:** `POST /v1/auth/email` always answers 202, so it cannot be used to
  enumerate accounts. Tokens are single-use, last 15 minutes, and are stored hashed. Each
  address gets at most 5 links per 15 minutes, counted in Postgres so the limit holds across
  replicas, plus an IP limit. The link carries the token in the **URL fragment**, so it
  never reaches a server log. The verify page needs a click, so link-preview bots cannot
  burn the token. The verify page sends `Referrer-Policy: no-referrer`.
- **GitHub OAuth:** state and a PKCE verifier live in a short-lived HMAC-signed cookie.
  Sign-in requires a **verified primary** email; accounts link by GitHub id first, then by
  that email. Post-login redirects accept only same-app relative paths. Base URLs are
  configurable for GitHub Enterprise and for the test fake.
- **First sign-in** creates a personal organization with the user as owner.
- **CSRF:** SameSite=Lax cookies, JSON-only request bodies (other content types get 415),
  and an Origin/Referer check against `PUBLIC_APP_URL` on every state-changing request
  (webhooks are exempt; they use HMAC from Phase 5).
- **Email provider:** Resend's HTTP API (`EMAIL_PROVIDER_API_KEY`), or the outbox transport
  outside production (ADR 0007).

## Consequences

The web app must call the API same-origin (ADR 0011). API tokens for the CLI come in
Phase 5.
