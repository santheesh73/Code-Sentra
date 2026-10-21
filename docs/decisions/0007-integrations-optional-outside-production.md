# 0007 — Integrations are required in production, optional elsewhere

- **Status:** accepted (Phase 1). Amends ADR 0003.

## Context

Section 20 lists the variables validated at startup. Section 20.2 also says: keep building
everything that does not depend on credentials only a human can provide, using local
substitutes. If every integration were required everywhere, a fresh checkout could not
start the API without GitHub, Slack and email accounts.

## Decision

`packages/config` splits each service's variables into three groups:
- **required:** always validated (`DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `PUBLIC_APP_URL`, …);
- **settings:** non-secret values with safe defaults (`API_PORT`, `GITHUB_OAUTH_BASE_URL`, …);
- **integrations:** all-or-nothing groups (`s3`, `github_oauth`, `github_app`, `email`,
  `slack`, `anthropic`).

With `NODE_ENV=production` every integration a service declares is required.
Elsewhere an integration may be entirely absent. `config.integrations.<name>` is then
`false`, and the feature it powers answers **501 "not configured"** and says which
variables to set. A partially configured integration is always an error.

`EMAIL_TRANSPORT=outbox` writes each email as a JSON file under `EMAIL_OUTBOX_DIR`. It
is refused in production. This is how local sign-in and the e2e gate work without an
email provider.

## Consequences

- Nothing is faked: a missing integration is visible (a 501, a startup warning, a
  "not configured" notice on the sign-in page, a skipped diagnostic step with its reason).
- Production still fails fast on any missing secret.
