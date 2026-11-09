# Service levels and error budgets

These are the service-level objectives CodeSentra operates to, the signals that measure them,
and the error budget each implies. They are deliberately modest for a self-hosted single-tenant
install; tighten them once you have baseline data. Alerting rules that fire before a budget is
exhausted are in [`../infra/observability/alerts.yml`](../infra/observability/alerts.yml); the
responses are in [`incident-runbook.md`](incident-runbook.md).

## SLIs and SLOs

| Service          | SLI (what we measure)                                                          | SLO (target)        | Error budget / window          |
| ---------------- | ------------------------------------------------------------------------------ | ------------------- | ------------------------------ |
| API availability | fraction of `GET /ready` checks that return 200                                | **99.5%**           | 0.5% ≈ 3h36m / 30d             |
| API latency      | p95 latency of non-SSE `2xx`/`4xx` requests                                    | **p95 < 500 ms**    | 5% of requests may exceed, 30d |
| Pulse freshness  | fraction of `pulse.run` jobs that reach a terminal state                       | **99%**             | 1% / 30d                       |
| Pulse latency    | p95 wall time of a `pulse.run` job                                             | **p95 < 30 s**      | 5% / 30d                       |
| Scan success     | fraction of `scan.run` jobs that finish (succeeded or partial, **not** failed) | **98%**             | 2% / 30d                       |
| Queue health     | age of the oldest unstarted job                                                | **< 300 s**         | breaches ≤ 1% of minutes / 30d |
| Worker liveness  | each worker type has ≥ 1 instance processing                                   | **100%** of minutes | alert immediately              |

Notes:
- A Scan that records **gaps** (sandbox unavailable, LLM budget reached) is still a success —
  the rule "a skipped check is never a pass" is about the report, not the job. Only a job that
  ends `failed` counts against the Scan SLO.
- SSE streams are excluded from API latency (they are long-lived by design).

## Where the signals come from

- **Traces**: every API request and job runs in an OpenTelemetry span (`@codesentra/telemetry`),
  exported over OTLP to your collector (`OTEL_EXPORTER_OTLP_ENDPOINT`). Span duration and status
  give the latency and success SLIs. Verify the pipeline with the collector integration test
  (`packages/telemetry/src/collector.integration.test.ts`).
- **`/ready`**: probe it from your uptime monitor for the availability SLI; it checks the
  database, queue and object storage (503 when any is down).
- **Queue age / dead letters**: `pgboss.job` (oldest `state='created'` row) and the
  `deadLetterJobs()` view / `GET /v1/orgs/:id/dead-letters`.
- **Errors**: Sentry (`SENTRY_DSN`) captures exceptions with trace ids; logs are structured
  (pino) and carry the trace id, never secrets.

## Error-budget policy

When a 30-day budget is more than half spent, freeze risky changes to that service and
prioritise reliability work until it recovers. When a budget is exhausted, page (not just
alert) and treat further regressions as incidents.
