# 0025 — Phase 7: hardening and the Phase 6 leftovers

- **Status:** accepted (Phase 7)

## Context

Section 18 ends at Phase 5, and Phase 6 (ADR 0024) closed the gaps that needed no outside
account. The user chose "hardening and leftovers" for Phase 7. That covered:
- an audit for real defects;
- the two leftovers from Phase 6: a diff-only incremental Scan, and replaying missed
  schedule windows.

The audit ran the CLI against every fixture app, every failure simulator and both fixture
repositories, and read every issue, re-check and prompt it produced.

## Decision

- **Same-code findings are separate issues.** `groupFindings` merged every finding that
  cited the same evidence. One response missing three security headers became one issue
  led by the first header, with `MISSING_SECURITY_HEADER` listed twice as corroboration.
  Fixing only that header resolved the issue and opened the others as new. Now only
  different codes corroborate each other, and a repeated code becomes its own group.
- **Re-checks name what they wait for.** Several expectations used `{locator}` where they
  meant the discriminator. For example, "app/page.tsx:9 is documented in .env.example"
  and "console error https://x/ not logged".
  - Templates can now use `{discriminator}`, clipped to its first line and 120 characters.
  - This applies to `MISSING_SECURITY_HEADER`, `CONSOLE_ERROR`, `UNCAUGHT_EXCEPTION`,
    `ENV_VAR_UNDOCUMENTED`, `ENV_VAR_UNUSED` and `TESTS_FAILING`.
  - Stored issues pick up the new text the next time they are seen.
- **Network idle is measured where Pulse fulfils requests.**
  - The problem: Chromium keeps an intercepted response open until the page reads its
    body. So a page that only checks `res.ok` (`env-undefined`) never reached
    `networkidle`. Its render waited the full 15 s and recorded `network_idle: false`.
  - The fix: the render check now waits for `load`, then for 500 ms with no request in
    its own route handler, within the same 15 s budget. On `env-undefined`, Pulse took
    15.8 s before and 1.4 s after, with the same findings. A regression test fails on the
    old code.
- **TLS findings name the endpoint.** `TLS_EXPIRING` used the host name alone, so two
  sites on one host with different ports shared a fingerprint. It now keeps the port, as
  `TLS_INVALID` already did. Default ports are unchanged, because `URL.host` omits 443.
- **Missed schedule windows: no change.** The scheduler already runs a schedule that fell
  behind once on the next tick, then moves `next_run_at` past now. The existing test
  covers six missed windows producing one run. The Phase 6 progress line saying windows
  are "not replayed" was wrong and is removed.
- **No diff-only map step.**
  - Measured on this repository: parsing takes about 1 s for 291 files (1.4 MB).
  - A PR scan's minutes go to downloading dependencies, installing, building and running
    tests. Those must run on the whole head tree to be correct.
  - So a per-file parse cache would add a tenant table and its invalidation for about a
    second per few hundred files. It is not built.
  - The real speedup would be a per-org dependency cache keyed by lockfile hash. That
    needs storage and a cache-poisoning review, so it is left for a decision.

## Consequences

- After this deploys, a site missing several security headers shows one issue per header.
  The extra headers were already missing; they were hidden inside the first header's issue.
- Renders that used to time out on unread response bodies now finish early. Their
  `network_idle` evidence becomes `true`.
