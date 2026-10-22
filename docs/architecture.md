# CodeSentra architecture

The kickoff document (Sections 1–20) is the source of truth. This file records what
exists in the repository now and how the pieces fit together. Decisions are in
[`decisions/`](decisions/), and the HTTP API is in [`api.md`](api.md) and [`openapi.json`](openapi.json).

## Current state: Phase 3 (Sentra Scan)

```
Browser ──► apps/web (Next.js) ──/api/* proxy──► apps/api (Fastify) ──► Postgres 16
                                                     │   ▲              (RLS, pg-boss)
                                                     │   └── LISTEN cs_run_events ◄──┐
                                                     └── enqueue (job id = run id)    │
                                                                                      │
                                             apps/worker-pulse ── step runner ── NOTIFY
                                               │  pulse.run: runPulse → evidence, findings,
                                               │  issues + prompts (ADR 0015)
                                               ├── safeFetch ──► the deployed site (ADR 0013)
                                               ├── Chromium (every request via safeFetch, ADR 0014)
                                               └── object storage (screenshots)

                                             apps/worker-scan ── step runner ── NOTIFY
                                               │  scan.run: ingest → map → history → probe
                                               │  → inventory → explain (ADR 0016–0018)
                                               ├── object storage (snapshots) / git (SSRF pin)
                                               ├── Docker sandbox (no network; one fetch step)
                                               ├── gitleaks container, OSV (API or snapshot)
                                               └── report model (Anthropic) → claim verifier

codesentra pulse <url> ── runPulse in-process (no account, no database)
codesentra scan [path|git-url] ── runScan in-process (same sandbox and model rules)
```

```
apps/
  api/            Fastify + Zod, OpenAPI 3.1, auth, orgs, projects, runs, SSE, Pulse,
                  Scan (snapshots, scan, report), issues, evidence, fix prompts; 501s
                  for later phases
  web/            sign-in, projects (health score), project (Scan card, environments
                  with Pulse status, issues), run (live; Pulse status or Scan report,
                  gaps, issues with prompts), issue, Quick Pulse, settings
  worker-pulse/   `system.diagnostic` and `pulse.run`
  worker-scan/    `scan.run`
  cli/            `codesentra pulse`, `codesentra scan` (Section 15 exit codes)
packages/
  core/           finding codes, schemas, fingerprints, Pulse status rule, issue grouping,
                  re-check specs and lifecycle, deriveRunStatus
  config/         per-service env validation; integrations optional outside production
  db/             Drizzle schema + migrations, RLS, withOrg(), runs, evidence, findings, issues
  queue/          pg-boss client, job specs, worker runtime, progress events, diagnostic job
  storage/        S3 client (MinIO-compatible)
  ssrf/           safeFetch: global-unicast only, DNS pinning, manual redirects, limits
  checks/         Pulse groups (reachability, platform, render, routes, hygiene), platform
                  adapters, issue drafts; `./job` is the pulse.run handler
  prompts/        versioned fix-prompt templates (code_fix for findings with a file and
                  line; Pulse code_fix waits for Phase 4 traces)
  parsers/        tree-sitter (TS, TSX, JS, Python): imports, symbols, routes, env reads,
                  markers, stubs, tests
  graph/          code graph, module resolution, git history (churn, co-change, hotspots)
  sandbox/        Docker sandbox (runsc or runc), limits, the dependency fetch step
  claims/         claim verifier: evidence, tokens, numbers, statuses, check assertions
  scan/           ingest (zip, git), map, probes and output parsers, OSV audit, gitleaks,
                  inventory, report model, pipeline; `./job` is the scan.run handler
infra/pulse/      worker-pulse image on Playwright 1.64.1 (pinned Chromium)
infra/sandbox/    the probe image (Python 3.12.15 + Node 22.23.4, uid 10001)
e2e/              Playwright gates: real Postgres + MinIO + API + worker + web + fixture harness
fixtures/         Phase 0 fixture apps, harness and repos
```

Not built yet: `apps/worker-link` (Phase 4).

## A Pulse run

1. `POST /v1/projects/{id}/pulse {environment_id}` (or `POST /v1/pulse {url, org_id}` for
   Quick Pulse) refuses IP-literal and localhost targets, creates the run with one step per
   check group (plus `issues` for projects), and enqueues `pulse.run`.
2. The worker runs the groups in order. If the main URL does not load (or answers 5xx), the
   later groups are skipped with that reason. Each group's start and end are live step events.
3. The status rule (Section 9, `computePulseStatus`) gives `live`, `degraded`, `down` or
   `unverified`. A blocked target or any skipped group is never `live`. The result is
   stored as `runs.outcome`, and the environment shows its latest one.
4. Evidence and findings are stored, and the screenshot goes to object storage. For project
   runs, `syncIssues` opens, re-sees, regresses or resolves issues by fingerprint, and
   versions their prompts. It resolves an issue only when the group its re-check names ran.

## A Scan run

1. `POST /v1/projects/{id}/snapshots` stores a zip (raw `application/zip` body) or registers
   a public https git ref (ADR 0018). `POST /v1/projects/{id}/scan` creates a run with one
   step per stage and enqueues `scan.run`. Without `snapshot_id`, it scans the project's
   `repo_url`.
2. **Ingest:** extract the zip under limits, or clone through the SSRF pin (ADR 0016). Then
   hash the tree. An identical tree already scanned in this project is reused: the run
   records its parent, and the remaining steps are skipped with that reason.
3. **Map:** manifests, docs, the code graph, routes, env vars, markers and tests.
   **History** (git only): churn, co-change and hotspots.
4. **Probe:** copy to scratch; fetch dependencies once, without running project code; then
   install, build, typecheck, lint and tests with no network. Audit lockfiles against OSV.
   Run gitleaks. Anything that cannot run is a gap.
5. **Inventory:** the model proposes features with evidence. Statuses come from rules:
   - `planned`: docs only;
   - `partial`: markers, or a failing or skipped covering test;
   - `complete`: a passing covering test, or a route with no markers.
6. **Explain:** the model drafts report sentences that cite evidence. The claim verifier
   drops any sentence it cannot verify, and keeps the reason. The health score (Section
   8a) is computed from evidence, never by the model.
7. Evidence, findings, the graph, features, the report and every claim are stored in one
   tenant transaction. `GET /v1/runs/{id}/report` serves the report, and
   `GET /v1/runs/{id}/findings` serves issues with prompts.

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

## Data model (Phase 1–3 tables)

`organizations`, `users`, `memberships`, `auth_identities`, `sessions`, `magic_link_tokens`,
`projects`, `environments`, `runs`, `run_steps`, `audit_log`, `evidence`, `findings`,
`issues`, `issue_findings`, `issue_events` (append-only under RLS), `fix_prompts`, `snapshots`,
`code_nodes`, `code_edges`, `features`, `reports`, `claims`. All tables have `id`,
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
docker build -t codesentra/sandbox:latest infra/sandbox   # Scan probes run in it
pnpm start:api & pnpm start:worker-pulse & pnpm start:worker-scan & pnpm start:web
# sign in at http://localhost:3000/signin; the link is written to .outbox/*.json
```

## Tests

- `pnpm test`: unit tests, plus integration tests on Testcontainers Postgres and MinIO (db
  RLS attacks, queue end to end, API including cross-org access on every route), plus the
  Phase 0 fixture gate.
- `pnpm e2e`: the Phase 1–3 gates in Chromium against the real stack. The Phase 3 gate
  builds the sandbox image unless `SANDBOX_IMAGE` names one. The fixture
  harness runs on 127.0.0.1 and is reachable only through the `NODE_ENV=test` allowance
  (ADR 0013).
- `codesentra pulse <url> [--json] [--fix-prompt] [--timeout=<ms>]`: after `pnpm build`, run
  `node apps/cli/dist/main.js`. Exit codes are 0 live, 1 degraded or unverified, 2 down, and
  3 usage error.
- `codesentra scan [path|git-url] [--json] [--fix-prompt]` scans in-process. It uses the
  sandbox if Docker and `SANDBOX_IMAGE` are present, and the report model if
  `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are set. It exits 1 on error findings or on
  anything not checked.
