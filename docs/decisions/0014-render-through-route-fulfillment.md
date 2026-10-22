# 0014 — Render check: Chromium never opens its own connections

- **Status:** accepted (Phase 2)

## Context

A real browser is needed to see what users see: client-side fetches built from unset env
vars, uncaught exceptions, blank pages. But a page under test is untrusted. Its scripts can
request anything, including internal addresses, and Chromium's own networking would
bypass the SSRF rules (ADR 0013).

## Decision

- The render check uses a fresh Chromium context (1366×768; service workers blocked;
  downloads off). `context.route("**/*")` intercepts **every** request, and each one is
  fulfilled from `safeFetch` with redirects not followed, so the browser follows them
  itself and every hop is intercepted again. Chromium makes no network connections of its
  own.
- Only GET and HEAD leave the page. Any other method is aborted and recorded as "not
  sent", so a check never submits a form or mutates state on the target.
- Requests to loopback hosts from a non-loopback page are aborted and recorded. That record
  is the `LOCALHOST_CALL` evidence, so the finding never depends on something being
  reachable on the worker's own loopback.
- The page's own document request is excluded from `SAME_ORIGIN_FAILURE`. Reachability
  reports a bad main status as `BAD_STATUS`, so it is never reported twice.
- Navigation waits for `networkidle`, capped at 15 s, then 500 ms for late timers. A
  timeout still yields findings, from what loaded. A browser that cannot start, or a page
  that cannot load, is a **gap** on the render group, never a pass (Rule 2).
- The screenshot is evidence like any other. Its bytes go to object storage, and the
  evidence row holds the storage key.

## Consequences

- Rendering is slower than raw Chromium networking, because bodies pass through Node.
  That is acceptable at Pulse's scale of one page plus at most 50 linked routes.
- WebSockets and other non-HTTP schemes are not exercised (they are aborted and recorded).
