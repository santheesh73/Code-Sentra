# 0022 — Schedules, alerts, API tokens and run limits

- **Status:** accepted (Phase 5)

## Context

Phase 5 adds recurring checks, notifications that carry each issue's prompt, tokens for
the CLI, and the Section 17 rate limits. Each of them has to hold with several API and
worker replicas, and none of them may widen what a tenant can reach.

## Decision

- **Schedules are a ticker, not a pg-boss cron job.**
  - Every job in the queue is keyed by a run id (ADR 0012). A schedule tick has no run.
    So worker-link calls `runDueSchedules` every `SCHEDULER_INTERVAL_SECONDS`.
  - The tick claims due rows with `FOR UPDATE SKIP LOCKED` and moves `next_run_at` forward
    in the same transaction, so any number of replicas tick without double-starting. Then
    it starts each Pulse with its Link run.
  - A missed window is not replayed: the next run is the next match after now.
  - Cron is five fields in UTC, parsed by a pure function in `packages/core` (no dependency).
  - The minimum interval is 5 minutes, at most 10 schedules per project, and `run_type` is
    `pulse` only (Section 12: "recurring Pulse").
- **`startLinked` lives in `packages/queue`.** The API (after its run limits) and the scheduler
  share it.
- **Alerts come from Link.**
  - After a sync-mode run commits, the issues it opened or regressed are rendered once
    (`packages/notify`, pure) and sent to each enabled channel of the project. Each issue
    carries its latest prompt, its traced location and a link.
  - PR-mode runs never alert: their check run is the report.
  - The result (`{ sent, failed }`) is recorded on the Link run. A failed channel stores
    its error, with any URL removed.
  - Email goes only to members of the org, so alerts cannot be aimed at outsiders.
  - Slack is added only through "Add to Slack" (OAuth, `incoming-webhook` scope). The
    webhook URL must be on `hooks.slack.com` when stored and again before every post,
    and redirects are refused.
  - Destinations are sealed at rest (purpose `notification-target`).
- **API tokens are bound to one org.**
  - Format `cs_<43 chars>`; only sha256 is stored.
  - A token acts as its user in exactly one org: `requireOrg` refuses any other org with
    404, and listings show only that org.
  - Bearer requests skip the Origin check: there is no ambient credential to forge.
  - Creating or revoking a token needs a signed-in session, not a token.
  - Tokens expire after 90 days by default. Creation and revocation are audited.
  - Runs started with a token have trigger `cli`.
- **Run limits are counted from `runs`.**
  - Limits: per org per hour, per user per hour, per run type per org per hour, and per
    target host per minute across all orgs (to protect the target).
  - Counting from `runs` makes them exact across replicas and restarts, with no new store.
    The answer is 429 with `Retry-After`.
  - Quick Pulse also keeps its per-IP limit.
  - Scheduled runs are bounded by the minimum interval rather than by these limits.
- **Bypass tokens for protected previews** are sealed per environment (purpose
  `bypass-token`). They are never returned and are sent only to the environment's own
  origin. Evidence never records request headers, so the token cannot be stored.

## Consequences

- A burst of webhooks for one org can hit the per-org limit. The webhook answers 429 and
  records the delivery as failed. A failed delivery (unlike a processed one) can be
  redelivered from GitHub with the same delivery id, which recovers it.
- The ticker's precision is the interval (30 s by default).
- Rotating `ENCRYPTION_KEY` needs a re-seal of every sealed column. The `v1.` prefix leaves
  room for that, but there is no rotation command yet (docs/progress.md).
