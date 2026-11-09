# Incident runbook

What to do when an alert from [`../infra/observability/alerts.yml`](../infra/observability/alerts.yml)
fires. Service levels are in [`slos.md`](slos.md); deployment and rollback are in
[`deployment.md`](deployment.md) and [`release.md`](release.md).

**First five minutes, always:** check `GET /ready` on the API (it names which dependency is
down — database, queue or storage), skim recent errors in Sentry (grouped by trace id), and
note whether a deploy went out recently (if so, consider rolling back first — see
[`release.md`](release.md#rollback)).

CodeSentra degrades honestly: when a dependency is down, jobs record a **gap** rather than a
false result, and `/ready` fails so the instance leaves rotation. So most incidents are
"restore the dependency", not "data is wrong".

---

## API /ready failing

`/ready` returns 503 and names the failed check.
1. **database** → see [Database outage](#database-outage).
2. **queue** → the pg-boss schema is unreachable; it shares the database, so usually the DB.
3. **storage** → see [Object storage outage](#object-storage-outage).
   If all three are ok but `/ready` still fails, the API process is wedged: check its logs, then
   restart the API container (another replica keeps serving).

## API error spike

5xx rate up.
1. Correlate in Sentry: one trace id or many? One endpoint or all?
2. All endpoints + recent deploy → **roll back** (`release.md#rollback`).
3. One endpoint → find the throwing span; if it is a dependency call, treat as that
   dependency's incident. The API never returns a fake 200, so a 5xx is a real failure.

## API latency

p95 over budget.
1. Check DB load (slow queries: `pg_stat_activity`, `EXPLAIN` the hot query on a replica).
2. Check queue age — if workers are starved, the API's enqueue path may be contending.
3. Scale the API horizontally (it is stateless) or the database if it is the bottleneck.

## A worker is down

`WorkerDown` for `worker-pulse`, `worker-scan` or `worker-link`.
1. Restart the worker container/VM. Workers are stateless and idempotent; in-flight jobs were
   either finished or will be retried, and the **stuck-job reaper** marks any run whose job died
   back to failed so nothing is left half-done.
2. worker-scan is a dedicated gVisor VM — confirm Docker and the `runsc` runtime are up there
   (see [Docker / sandbox loss](#docker--sandbox-loss)).
3. Run several replicas so one loss does not stop processing (the queue hands each job to one
   replica — see `packages/queue`).

## Queue backlog

`QueueBacklog`: oldest unstarted job is old.
1. Are workers alive and keeping up? If not, [restart / scale](#a-worker-is-down) them.
2. A burst of scans is CPU-bound; add worker-scan replicas.
3. Check for a poison job repeatedly failing and blocking a queue — look at
   [dead letters](#dead-letters) and the job's error.

## Dead letters

Jobs in the failed state (`GET /v1/orgs/:id/dead-letters`, or the metric).
1. Read the reason. A real bug in a handler → fix forward and deploy.
2. The owning runs are already marked failed by the reaper; users see a failed run, never a
   false success. Re-run is user-initiated (or scheduled).

## Scan failures

`ScanFailureRateHigh`.
1. Distinguish **failed** jobs (count against the SLO) from **gaps** (sandbox/LLM unavailable —
   the scan still produced a report). Gaps point to a dependency, not a Scan bug.
2. A spike of real failures after a deploy → roll back. Otherwise find the common stage in the
   failing runs' steps.

## Docker / sandbox loss

The scan VM's Docker daemon or gVisor runtime is unavailable; scans record a sandbox gap.
1. On the scan VM: `systemctl status docker`; confirm `runsc` is installed and selected
   (`SANDBOX_RUNTIME=runsc`). The worker **refuses `runc` in production**, so a misconfigured
   runtime makes every scan a gap rather than running untrusted code unsafely.
2. Restart Docker; the worker retries and the gap clears. No scan ever ran code outside the
   sandbox, so there is nothing to clean up.

## LLM outage or budget

Scans record LLM gaps.
1. **Provider outage**: report prose is skipped; the deterministic report (map, probes, audits,
   health score) is unaffected. Wait it out or switch `ANTHROPIC_MODEL`; no action corrupts data.
2. **Budget reached**: an org hit `LLM_MONTHLY_TOKEN_CAP`. Raise the cap or wait for the month
   to roll over. This is working as designed, not an outage.

## Registry outage

The image registry (GHCR) is down during a deploy.
1. Deploys that pull images will fail — the running stack is unaffected. Pause the rollout.
2. If mid-rollout, roll back to the previously pulled tag (already on the hosts).

## Object storage outage

`StorageErrors` / `/ready` storage check failing.
1. Confirm the bucket/endpoint and credentials (`S3_*`). Restore the service or failover.
2. While down: Scan ingest fails (snapshots cannot be stored) and uploads 501; Pulse and Link
   that do not touch storage keep working. No partial data is written — ingest fails atomically.

## Database outage

1. `/ready` database check fails; the API and workers cannot proceed.
2. Restore the managed Postgres or failover to a replica. On data loss, restore from backup and
   rehearse first (`scripts/backup-restore.sh rehearse`), then point `DATABASE_URL` at the
   restored database and restart. Migrations are idempotent; re-running them is safe.

---

## After any incident

Write a short note: what fired, the trace ids, the root cause, and whether an SLO budget was
spent (`slos.md`). If a budget is more than half gone, freeze risky changes to that service
until it recovers.
