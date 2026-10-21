# 0012 — Jobs, idempotency and live progress

- **Status:** accepted (Phase 1)

## Decision

- **pg-boss 12** in schema `pgboss`; one queue per job type. Each queue sets
  `retryLimit: 3`, exponential backoff, and `expireInSeconds` from the per-type timeout
  (scan 15 min, pulse 2 min, link 5 min, diagnostic 1 min), overridable with
  `JOB_TIMEOUT_<TYPE>`.
- **Idempotency:** a job's id _is_ its run id, so enqueueing the same run twice is a
  no-op. A retried attempt re-runs the handler: `startStep` resets a step, and `markRunRunning`
  refuses runs that already finished.
- **Payloads** are `{ runId, orgId }`, validated with Zod on enqueue and on claim. The
  worker does all tenant work through `withOrg(orgId)`.
- **Step runner:** handlers call `ctx.step(name, fn)`. The runtime records running, done,
  skipped (a reason is required) or failed, with duration and a capped log. If the handler
  returns with unfinished steps, that is an error. On the final failed attempt, `failRun`
  fails the running step and marks unstarted steps skipped with "not run: the run failed
  before this step started". The run status is derived by `deriveRunStatus`: any failed step
  makes it failed, else any skipped step makes it partial, else it succeeded.
- **Dead jobs:** a crashed or expired final attempt leaves no handler alive. Every minute,
  each worker sweeps for runs still queued or running whose pg-boss job is `failed`, and
  fails them, so nothing stays "running" forever.
- **Progress:** each state change calls `pg_notify('cs_run_events', {runId, orgId, kind,
  status, step?})` _inside the same transaction_, so listeners only hear about committed
  state. The API holds one LISTEN connection and fans events out by run id.
  `GET /v1/runs/{id}/stream` sends a full run snapshot first and after every event (subscribing
  before the first read so nothing is missed), sends a heartbeat every 15 s, and closes at a
  terminal status. NOTIFY is not replayed, so clients treat each snapshot as the full truth.
