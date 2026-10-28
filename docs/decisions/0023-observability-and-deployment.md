# 0023 — Tracing, error reporting and the deployment topology

- **Status:** accepted (Phase 5)

## Context

Section 19 asks for an OpenTelemetry span per worker step, with traces from the API
through the queue to the workers, and Sentry. Section 18 asks for production images, with
the web on Vercel and the API, workers and Postgres on Render or Fly. The sandbox
(Section 8.4) needs a Docker daemon with gVisor.

## Decision

- **Tracing without auto-instrumentation.**
  - `packages/telemetry` exposes `withSpan` and the traceparent helpers on
    `@opentelemetry/api` alone. Libraries depend only on that, and every span is a no-op
    until a service calls `initTelemetry` (`./init`).
  - `initTelemetry` registers a tracer provider with OTLP/HTTP export when
    `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  - The span tree:
    - each API route handler runs in a span named by its route pattern (low cardinality);
    - `enqueue` copies the active `traceparent` into the job payload;
    - the worker continues it in a `job <type>` span;
    - every step is a `step <name>` span with its status and gap reason.
  - The OTel versions are pinned to releases at least two weeks old.
- **Sentry reports errors only.**
  - Sentry is initialized with `skipOpenTelemetrySetup` and no default integrations, so it
    does not instrument anything or conflict with the tracer.
  - It receives final job failures and API 5xx.
  - `scrubEvent` removes bodies, cookies, `authorization` and webhook signatures.
- **Images.**
  - `infra/node` builds the API or worker-link (`SERVICE` build arg).
  - `infra/scan` builds worker-scan: git plus Docker's static CLI, pinned by version and
    sha256.
  - `infra/pulse` (Phase 2) builds worker-pulse.
  - All images run as non-root. CI builds and smoke-tests every image and scans it with
    Trivy, pinned by digest: a fixable CRITICAL vulnerability fails the job, and HIGH ones
    are listed.
  - `pnpm audit --prod --audit-level=high` fails on advisories. Accepted exceptions live in
    `pnpm-workspace.yaml`, each with its reason.
- **Topology.**
  - Web on Vercel. Its same-origin proxy (ADR 0011) now also forwards `Authorization`
    (CLI tokens) and GitHub's webhook headers.
  - API, worker-link, worker-pulse and Postgres on Render (`render.yaml`, with no
    auto-deploy). Migrations run as the API's pre-deploy command.
  - worker-scan on a dedicated VM with Docker and runsc (`infra/deploy/`), because neither
    Render nor Fly offers a Docker daemon with gVisor.

## Consequences

- Vercel functions cap request bodies at 4.5 MB. So large zip uploads and large GitHub
  push payloads should go to the API's own URL, not through the web proxy. The runbook
  points the GitHub webhook at the API URL.
- Nothing is deployed by the repository. Deploying needs accounts and secrets only a
  person can provide (docs/runbook.md).
