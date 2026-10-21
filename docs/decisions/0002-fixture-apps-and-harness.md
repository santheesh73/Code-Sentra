# 0002 — Fixture apps are Next.js static exports served by a local harness

- **Status:** accepted (Phase 0)

## Context

Every gate depends on known-broken deployments. CI must not depend on a third-party
host (Section 13).

## Decision

- Each fixture in `fixtures/apps/*` is a real Next.js app built with `output: "export"`.
  The source (`app/page.tsx`, …) is what Scan and Link see; the static export is what
  Pulse sees.
- `env-undefined` has two build variants: `broken` (`out/`, `NEXT_PUBLIC_API_URL` unset)
  and `fixed` (`out-fixed/`, `NEXT_PUBLIC_API_URL=/backend`). The harness switches the
  served variant at runtime (`POST /__harness/apps/:name/variant`), which is how Phase 4
  proves resolve and regress without rebuilding.
- `fixtures/harness` serves each app on its own loopback port, sends a full set of
  security headers (so hygiene findings never fire by accident), and runs the failure
  simulators: 5xx, 404, timeout, slow TTFB, redirect loop, a 5-hop chain, connection
  refused, DNS failure (an RFC 2606 `.invalid` name), and TLS valid, expiring, expired,
  wrong-host and self-signed. The TLS certificates come from a throwaway CA generated
  at startup and are never written to disk.
- Each app's `fixture.json` records two things: what a browser must observe (`selfTest`),
  which the harness test checks in real Chromium, and the expected Pulse and Link outcome
  (`expected`), which the Phase 2 and Phase 4 gates will assert. Trace line numbers are
  checked against the source by a test, so they cannot drift.
- Every app ships `app/icon.svg`. Without one, Chromium requests `/favicon.ico` and the
  `healthy` control logs a 404 (found by the self-test).

## Consequences

- The harness binds 127.0.0.1. Pulse's SSRF guard must reject loopback, so Phase 2 needs
  an explicit, test-only allowlist for harness targets. It must be off by default and refused
  in production config. To be recorded as its own ADR when built.
- Pulse should treat a browser-initiated `/favicon.ico` 404 as info, not
  `SAME_ORIGIN_FAILURE`, because real sites hit the same noise.
