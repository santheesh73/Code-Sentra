# CodeSentra architecture

The kickoff document (Sections 1–20) is the source of truth. This file records what
exists in the repository now and how the pieces fit together. Decisions are in
[`decisions/`](decisions/), and the HTTP API is in [`api.md`](api.md) and [`openapi.json`](openapi.json).

## Current state: Phase 1 (foundation)

```
Browser ──► apps/web (Next.js) ──/api/* proxy──► apps/api (Fastify) ──► Postgres 16
                                                     │   ▲              (RLS, pg-boss)
                                                     │   └── LISTEN cs_run_events ◄──┐
                                                     └── enqueue (job id = run id)    │
                                                                                      │
                                             apps/worker-pulse ── step runner ── NOTIFY
                                                     └── object storage (MinIO / S3)
```

```
apps/
  api/            Fastify + Zod, OpenAPI 3.1, auth, orgs, projects, runs, SSE, 501s for later phases
  web/            Next.js App Router: sign-in, projects, new project, project, run (live), settings
  worker-pulse/   runs `system.diagnostic` now; Pulse checks in Phase 2
packages/
  core/           finding codes, schemas, fingerprints, status rules, deriveRunStatus
  config/         per-service env validation; integrations optional outside production
  db/             Drizzle schema + migrations, RLS, withOrg(), run/step queries, test DB helper
  queue/          pg-boss client, job specs, worker runtime, progress events, diagnostic job
  storage/        S3 client (MinIO-compatible)
e2e/              Playwright gate: real Postgres + MinIO + API + worker + web
fixtures/         Phase 0 fixture apps, harness and repos
```

Not built yet: `apps/{worker-scan,worker-link,cli}`, and
`packages/{graph,parsers,checks,claims,prompts,sandbox,ssrf}`.

## Request path

1. The browser only ever talks to `PUBLIC_APP_URL`. `/api/*` is streamed to the API
   (ADR 0011), so the session cookie is first-party.
2. The API resolves `cs_session` to a user (hashed lookup). Every state-changing request must
   carry the app's Origin and a JSON body (ADR 0010).
3. Routes authorize first: membership and role, with 404 for anything outside the caller's
   orgs. Then they read and write through `db.withOrg(orgId)`, where Postgres RLS filters
   every statement (ADR 0009).
4. Long operations create a `run` with ordered `run_steps`, enqueue a pg-boss job whose id is
   the run id, and answer `202 { run_id }`.

## Run lifecycle

`queued → running → succeeded | partial | failed`. The worker claims the job, marks the run
running, and executes declared steps through `ctx.step()`. Each transition commits together
with a `pg_notify`, and the API's single listener pushes full run snapshots over
`GET /v1/runs/{id}/stream`. A skipped step must carry a reason and makes the run
`partial`. A final failed attempt marks unstarted steps skipped with the reason. A sweep
fails runs whose job died (ADR 0012).

## Data model (Phase 1 tables)

`organizations`, `users`, `memberships`, `auth_identities`, `sessions`, `magic_link_tokens`,
`projects`, `environments`, `runs`, `run_steps`, `audit_log`. All tables have `id`,
`created_at` and `updated_at`. Tenant tables have `org_id` with RLS, and children use composite
`(org_id, parent_id)` foreign keys. The other Section 6 tables arrive with the phases that use them.

## Local development

```sh
pnpm install
cp .env.example .env     # set POSTGRES_PASSWORD, DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY,
                         # PUBLIC_APP_URL=http://localhost:3000, EMAIL_TRANSPORT=outbox, S3_* for MinIO
pnpm infra:up            # postgres + minio + bucket
pnpm build
pnpm db:migrate
pnpm start:api & pnpm start:worker-pulse & pnpm start:web
# sign in at http://localhost:3000/signin; the link is written to .outbox/*.json
```

## Tests

- `pnpm test`: unit tests, plus integration tests on Testcontainers Postgres and MinIO (db
  RLS attacks, queue end to end, API including cross-org access on every route), plus the
  Phase 0 fixture gate.
- `pnpm e2e`: the Phase 1 gate in Chromium against the real stack.
