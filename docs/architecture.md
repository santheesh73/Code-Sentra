# CodeSentra architecture

The kickoff document (Sections 1–20) is the source of truth. This file records what
exists in the repository now and how the pieces fit together. Decisions are in
[`decisions/`](decisions/), and the HTTP API is in [`api.md`](api.md) and [`openapi.json`](openapi.json).

## Current state: Phase 6 (closing the Phase 1–5 gaps, ADR 0024)

```
Browser, CLI ─► apps/web (Next.js) ──/api/* proxy──► apps/api (Fastify) ──► Postgres 16
GitHub webhooks ─────────────────────────────────┘    │   ▲              (RLS, pg-boss)
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

                                             apps/worker-link ── step runner ── NOTIFY
                                               │  link.run: trace → widen → prompt → verify
                                               │  (stored evidence + code graph → traces,
                                               │  blast radius, prompts, issue lifecycle)
                                               ├── started by the completion hook when every
                                               │   child Scan/Pulse run of a check finished
                                               ├── GitHub check runs (one per commit, ADR 0021)
                                               ├── alerts: email (Resend) + Slack webhooks
                                               └── scheduler: fires due Pulse and full-check
                                                   schedules (ADR 0022, 0024)

Every handler, job and worker step is an OpenTelemetry span; the job payload carries
the W3C traceparent (ADR 0023). Sentry receives final job failures and API 5xx.

codesentra pulse <url> ── runPulse in-process (no account, no database)
codesentra scan [path|git-url] ── runScan in-process (same sandbox and model rules)
codesentra login / check --project <id> [--wait] ── the API with an API token
(apps/cli/dist/npm/codesentra.mjs: the same CLI as one file for npm, ADR 0024)
```

```
apps/
  api/            Fastify + Zod, OpenAPI 3.1, auth (session or API token), orgs,
                  projects, runs, SSE, Pulse, Scan, check, issues, evidence, fix prompts,
                  GitHub App (webhooks, install), schedules, notifications, API tokens,
                  audit log, run limits
  web/            sign-in, projects (health score), project (Scan card, environments
                  with Pulse status, issues), run (live; Pulse status or Scan report,
                  gaps, issues with prompts), issue, Quick Pulse, settings (members,
                  GitHub App, API tokens, audit log), project settings (repository,
                  bypass tokens, schedules, notifications)
  worker-pulse/   `system.diagnostic` and `pulse.run`
  worker-scan/    `scan.run`, `scan.incremental` (GitHub commits)
  worker-link/    `link.run` (Pulse also serves `issue.recheck`), alerts, the scheduler
  cli/            `codesentra pulse`, `scan`, `login`, `check` (Section 15 exit codes);
                  `bundle/` builds the single-file npm package
packages/
  core/           finding codes, schemas, fingerprints, Pulse status rule, issue grouping,
                  re-check specs and lifecycle, deriveRunStatus
  config/         per-service env validation; integrations optional outside production
  db/             Drizzle schema + migrations, RLS, withOrg(), runs, evidence, findings, issues
  queue/          pg-boss client, job specs, worker runtime, progress events, diagnostic job
  storage/        S3 client (MinIO-compatible), presigned upload policies
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
  link/           exact-join trace rules, blast radius, check-run report; `./job` is the
                  link.run handler (issues, check runs, alerts)
  github/         GitHub App client (JWT, installation tokens, check runs, compare,
                  zipballs, OAuth proof of access), webhook schemas and signature check
  notify/         alert rendering (email, Slack), email transports, Slack delivery
  telemetry/      spans and error reporting; `./init` starts OTLP export and Sentry
infra/docker-compose.yml  infrastructure; profile `app` runs the whole app (`pnpm stack:up`)
infra/node/       production image for the API and worker-link
infra/web/        web image (`next start`) for the compose stack
infra/scan/       worker-scan image (git, checksum-pinned Docker CLI)
infra/deploy/     worker-scan on a VM with Docker + gVisor
infra/pulse/      worker-pulse image on Playwright 1.64.1 (pinned Chromium)
infra/sandbox/    the probe image (Python 3.12.15 + Node 22.23.4, uid 10001)
e2e/              Playwright gates: real Postgres + MinIO + API + worker + web + fixture harness
fixtures/         Phase 0 fixture apps, harness and repos
```

Deployment (nothing is deployed automatically; see [`runbook.md`](runbook.md)): the web app
on Vercel (`apps/web/vercel.json`); the API, worker-link, worker-pulse and Postgres on
Render (`render.yaml`); worker-scan on a VM with Docker and gVisor
(`infra/deploy/worker-scan.compose.yml`). Section 17 is mapped to code and tests in
[`security.md`](security.md).

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
   runs, the Link run that follows opens, re-sees, regresses or resolves issues by
   fingerprint, and versions their prompts. It resolves an issue only when the group its
   re-check names ran.

## A full check (Link)

1. `POST /v1/projects/{id}/check` creates a Link run with these children:
   - a Scan of the given snapshot, else of the linked GitHub repository at the default
     branch's head (cloned with history), else a clone of `repo_url`;
   - a Pulse run per environment.
     Children carry `parent_run_id` = the Link run. Project Pulse (`/pulse`), Scan (`/scan`)
     and re-checks (`/issues/{id}/recheck`) create a Link run the same way, with a single
     child (ADR 0019).
2. Each child runs in its own worker. Pulse also probes the latest Scan's static GET
   routes. When the last child finishes, `startLinkIfReady` enqueues `link.run`. A child
   that failed still triggers it, and its gap is recorded.
3. **trace:** each issue's leading finding is joined exactly to a stored code fact:
   - URL templates by static suffix;
   - URL literals by host and port;
   - routes and handlers by path. No route means `ROUTE_MISSING`, traced to the href;
   - throw/Error/console.error literals by message;
   - the page component;
   - Scan locators directly (ADR 0020).
     **widen:** importers up to 2 hops, plus the top 5 co-change partners.
4. **prompt:** `code_fix` when traced, with the file, line, symbol, env vars and the
   blast radius; else the Phase 2 types. A Scan `ENV_VAR_UNDOCUMENTED` finding at a trace
   site for the same env var joins the Pulse issue instead of opening its own. **verify:** `syncIssues` per child opens,
   re-sees, resolves (only when the check group ran) and regresses issues, and stores
   traces and the blast radius.

## A Scan run

1. Zips go straight to storage: `POST /v1/projects/{id}/uploads` returns a presigned POST
   (key, type and size pinned), and `.../uploads/{snapshotId}/complete` checks the object
   before the snapshot can be scanned (ADR 0024). `POST /v1/projects/{id}/snapshots` still
   takes a raw `application/zip` body, or registers a public https git ref (ADR 0018). `POST /v1/projects/{id}/scan` creates a run with one
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

## Data model (Phase 1–5 tables)

`organizations`, `users`, `memberships`, `auth_identities`, `sessions`, `magic_link_tokens`,
`projects`, `environments`, `runs`, `run_steps`, `audit_log`, `evidence`, `findings`,
`issues`, `issue_findings`, `issue_events` (append-only under RLS), `fix_prompts`, `snapshots`,
`code_nodes`, `code_edges`, `features`, `reports`, `claims`, `traces`, `github_installations`
(sealed; readable by its own org only), `webhook_deliveries` (system only),
`github_check_runs`, `schedules`, `notification_channels` (destinations sealed), `api_tokens`
(sha256 only). All tables have `id`, `created_at` and `updated_at`. Tenant tables have `org_id`
with RLS, and children use composite `(org_id, parent_id)` foreign keys.

## Local development

```sh
pnpm install
cp .env.example .env     # set POSTGRES_PASSWORD, DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY,
                         # PUBLIC_APP_URL=http://localhost:3000, EMAIL_TRANSPORT=outbox, S3_* for MinIO
pnpm infra:up            # postgres + minio + bucket
pnpm build
pnpm db:migrate
docker build -t codesentra/sandbox:latest infra/sandbox   # Scan probes run in it
pnpm start:api & pnpm start:worker-pulse & pnpm start:worker-scan & pnpm start:worker-link & pnpm start:web
# sign in at http://localhost:3000/signin; the link is written to .outbox/*.json
```

Or run everything in containers: `pnpm stack:up` (needs `.env` with POSTGRES_PASSWORD,
S3_*, SESSION_SECRET, ENCRYPTION_KEY and, for Scan's sandboxes, `DOCKER_GID`; the sign-in
email lands in the `outbox` volume). `pnpm stack:down` stops it.

## Tests

- `pnpm test`: unit tests, plus integration tests on Testcontainers Postgres and MinIO (db
  RLS attacks, queue end to end, API including cross-org access on every route), plus the
  Phase 0 fixture gate.
- `pnpm e2e`: the Phase 1–4 gates in Chromium against the real stack. The Phase 3 gate
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
