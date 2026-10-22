# 0008 — The Phase 1 "test job" is a real diagnostic run

- **Status:** accepted (Phase 1)

## Context

The Phase 1 gate says: "a user … triggers a test job, and watches its steps live". Rule 6
forbids canned results. A job that sleeps and prints "ok" would be exactly that.

## Decision

Add run type `diagnostic` and job type `system.diagnostic`.
`POST /v1/projects/{id}/diagnostic` creates a run with three steps, which worker-pulse
executes:
1. **database:** a tenant-scoped round trip through `withOrg`, which fails if the RLS scope
   was not applied; logs the server version and latency.
2. **queue:** the measured delay between enqueue and pickup.
3. **object_storage:** writes, reads back, compares and deletes 64 random bytes in the
   bucket. When S3 is not configured, the step is **skipped with a reason** and the run
   ends `partial`, never `succeeded`.

The run stays useful after Phase 1 as a health check of a deployment's pipeline.

## Consequences

`RunType` gained `diagnostic` (a Postgres enum value). It is not one of Section 6's run
types, and it is recorded here for that reason.
