# Progress

## Phase 2 — Sentra Pulse (2026-10-22)

### Built

- **`packages/ssrf`** (ADR 0013): `safeFetch` allows only global-unicast addresses. DNS is
  resolved once and pinned. Redirects are manual and re-validated at every hop. `localhost`
  names are refused. Timeouts, body caps, and a per-host limiter. `testPolicy` exists only
  under `NODE_ENV=test`.
- **`packages/checks`:** the five Pulse groups.
  - reachability: DNS, TLS validity and expiry, main URL, redirects, TTFB.
  - platform: Vercel, Netlify, Render, Cloudflare Pages, Fly and generic adapters;
    environment detection; access walls; config hints.
  - render: Chromium with every request fulfilled through `safeFetch`; GET/HEAD only;
    loopback calls recorded, never sent (ADR 0014).
  - routes: up to 50 same-origin links.
  - hygiene: security headers and similar checks.
  - Also `runPulse`, issue drafts, and the `pulse.run` job (`@codesentra/checks/job`).
- **`packages/core`:**
  - The Section 9 status rule. A blocked target is `unverified`; a skipped group is never
    `live`.
  - Merging findings by shared evidence (the most specific code leads).
  - Re-check specs and the issue lifecycle.
- **`packages/prompts`:** versioned `outage_triage`, `config_fix` and `investigate`
  templates. `code_fix` refuses to render until there is a code trace (Phase 4).
- **`packages/db`:** `evidence`, `findings`, `issues`, `issue_findings`, `issue_events`
  (append-only) and `fix_prompts`, all under RLS. `runs.outcome`. `syncIssues` opens issues,
  records sightings, regresses resolved ones that reappear, and resolves an issue only when
  its check group ran (ADR 0015).
- **`apps/api`:**
  - `POST /v1/projects/{id}/pulse` and Quick Pulse `POST /v1/pulse` (10/min). Both refuse
    private targets.
  - Issues list, detail, fix prompt and dismiss (audited); evidence; run findings (with
    prompts); screenshot.
  - Environments carry their latest Pulse status, and projects their open-issue count.
  - Cross-org tests cover every new route.
- **`apps/worker-pulse`:** `pulse.run`, with one step per check group (live over SSE) and a
  shared Chromium that relaunches if it crashes.
- **`apps/web`:**
  - The project page shows Pulse status per environment, a "Check now" button, and issues.
  - The run page shows the Pulse status, gaps per group, issues with prompts (copy button,
    type label), evidence, and the screenshot.
  - New pages: issue (observation, evidence drawer, re-check, prompt, history, dismiss)
    and Quick Pulse.
- **`apps/cli`:** `codesentra pulse <url> [--json] [--fix-prompt] [--timeout=<ms>]` runs
  in-process.
  - Exit codes: 0 live, 1 degraded, 2 down, 3 usage. Without Chromium, render is a gap
    and the status is `unverified`.
  - `scan`, `check` and `login` say which phase brings them.
- **`infra/pulse/Dockerfile`:** worker-pulse on the Playwright 1.64.1 image (Chromium
  156.0.8078.4, the build playwright-core drives) with Node 22.23.4. CI builds it and
  launches Chromium inside.
- **Fixture harness:** new `access-protected` and `preview-deployment` simulators (promised
  in Phase 0). Both run end to end: `ACCESS_PROTECTED` gives `unverified` with gaps, and
  `PREVIEW_SERVED_AS_PROD` is found when the preview is registered as production.
  `connection-refused` now uses a probed privileged port. A freed ephemeral port could be
  taken by a parallel test, and the full-suite run caught that once.
- **`e2e/`:** the Phase 2 gate through the whole stack (below).

### Decisions

- **`unverified` exits with 1** in the CLI, not 0. Section 15 lists only live, degraded and
  down. An unchecked group must never look like a pass in CI (Rule 2).
- **Quick Pulse runs store findings and evidence but no issues.** Issues belong to a project
  environment. Their prompts are rendered when the findings are read.
- **Pulse issues are synced by worker-pulse until Link exists** (ADR 0015).

### Deferred or partial

- **`code_fix` prompts and code traces** (the fixture manifests' `promptType: code_fix`
  and `trace`) need Scan and Link and are Phase 4 gate items. Pulse issues currently get
  `investigate` ("Unconfirmed lead"), `config_fix` or `outage_triage`.
- **Scan-discovered routes:** the routes group checks links found on the page only. Routes
  from Scan (`scanRoutes`) arrive in Phase 3.
- **Preview bypass tokens:** `environments.bypass_token_ref` exists, and the check can send a
  bypass header, but there is no secret storage or UI to register one yet (Phase 5 with API
  tokens). Until then an access-protected deployment is `unverified` with that gap.
- **Not built yet (answer 501):** `POST /v1/issues/{id}/recheck`, schedules and
  notifications. Re-checks happen on the next Pulse of the same environment.
- **Rate limits:** the Quick Pulse limit is per IP, not per org.
- **Platform adapters** are tested against simulated headers and host names, not against
  real accounts on each platform.
- **The Pulse image is large** (~3.9 GB on disk; the Playwright base ships Firefox and
  WebKit too). docker-compose still runs infrastructure only.
- **The CLI is a private workspace package.** Bundling and publishing it to npm is Phase 5.

### Known risks

- **Render traffic passes through Node** (ADR 0014). That is fine for one page and its
  assets, but large media-heavy pages are slower than native Chromium networking.
- **Platform detection** relies on headers and URL patterns that the platforms can change.
  The adapters are isolated so one can be updated alone.

### Gate result

Lint, typecheck and build were first run from a clean tree (all build outputs and turbo
caches deleted). The final run below is after the last change, on 2026-10-22:

```
pnpm lint          Checked 256 files. No fixes applied.
pnpm typecheck     Tasks: 38 successful, 38 total
pnpm build         Tasks: 19 successful, 19 total
pnpm test          Tasks: 29 successful, 29 total
  @codesentra/core             51 passed   (status rule, grouping, lifecycle)
  @codesentra/config           19 passed
  @codesentra/storage           3 passed
  @codesentra/ssrf             70 passed   (SSRF suite: every refused range, rebinding,
                                            redirect re-validation, allowance guard)
  @codesentra/checks           36 passed   (every fixture app and variant, 15 simulators,
                                            platform findings, gaps never pass, prompts)
  @codesentra/prompts           7 passed
  @codesentra/db               22 passed   (RLS on Pulse tables, issue sync lifecycle)
  @codesentra/queue             6 passed
  @codesentra/api              38 passed   (Pulse + issues end to end, cross-org on every route)
  @codesentra/cli              15 passed   (exit codes, JSON, --fix-prompt, no-browser gap,
                                            SSRF under the default policy)
  @codesentra/fixture-harness  44 passed
pnpm openapi       docs/openapi.json and docs/api.md unchanged
pnpm e2e           9 passed
  ✓ Phase 1 tests (3, plus the 375 px check on mobile)
  ✓ Phase 2 gate: every fixture app returns its expected status and findings
  ✓ an issue opens with evidence and a prompt, then resolves after the fix deploys
  ✓ Quick Pulse checks a pasted URL without a project and refuses private targets
  ✓ @responsive Phase 2 pages fit a 375 px screen (desktop + mobile projects)
docker build -f infra/pulse/Dockerfile   chromium 156.0.8078.4 launches in the image
```

The e2e gate signs in and registers all six fixture apps as environments of one project.
For each app and variant it clicks "Check now", and the real worker checks the app in
Chromium through the SSRF policy. The test then compares the run's status and its
non-info findings with the manifest. All seven app–variant combinations match:

| App                | Variant | Status   | Findings                                                            |
| ------------------ | ------- | -------- | ------------------------------------------------------------------- |
| `healthy`          | default | live     | none (zero issues)                                                  |
| `env-undefined`    | broken  | degraded | `UNDEFINED_IN_URL` and `SAME_ORIGIN_FAILURE`, merged into one issue |
| `env-undefined`    | fixed   | live     | none                                                                |
| `blank` | default | degraded | `BLANK_PAGE` |
| `broken-route` | default | degraded | `ROUTE_BROKEN` |
| `console-throw` | default | degraded | `UNCAUGHT_EXCEPTION` |
| `localhost-leak` | default | degraded | `LOCALHOST_CALL` |

It also requires that no group was skipped, and that every issue has a stored prompt, both
in the API and on the page. A second test watches an issue open on `env-undefined`
(broken) and resolve once the fixed variant is deployed.

**Phase 2 gate: passed locally.**

## Phase 1 — Foundation (2026-10-21)

### Built

- **`packages/db`:** Drizzle schema and migrations for organizations, users, memberships,
  auth identities, sessions, magic-link tokens, projects, environments, runs, run_steps and
  audit_log. Postgres RLS through `withOrg()` (ADR 0009), with composite FKs keeping child rows
  in their parent's org. Shared run and step queries. A Testcontainers helper.
- **`packages/queue`:** pg-boss 12 client where the job id is the run id. Zod payloads,
  per-type timeouts, 3 retries with backoff, a worker runtime with a step runner,
  final-attempt failure, a dead-job sweep, and LISTEN/NOTIFY progress events (ADR 0012).
- **`packages/storage`:** S3 client with key validation (MinIO-compatible).
- **`packages/config`:** integrations are required in production and optional elsewhere
  (they answer 501 when absent); email outbox transport for dev and test (ADR 0007).
- **`packages/core`:** `diagnostic` run type, and `deriveRunStatus` (a skipped step makes the run partial).
- **`apps/api`:**
  - Auth: magic link and GitHub OAuth with PKCE, hashed session tokens, an Origin check,
    JSON-only bodies, and IP and per-address rate limits (ADR 0010).
  - Orgs and members, with audited role changes and a last-owner guard.
  - Projects and environments; diagnostic runs; run read and SSE stream.
  - RFC 9457 errors; generated OpenAPI 3.1 (`docs/openapi.json`, `docs/api.md`, with a drift
    test and CI check).
  - Section 12 endpoints for later phases authorize, then answer 501.
- **`apps/worker-pulse`:** runs the real platform diagnostic (database, queue, object
  storage) (ADR 0008).
- **`apps/web`:**
  - Next.js 16 + Tailwind 4 + shadcn-style components + TanStack Query, with the
    same-origin API proxy (ADR 0011).
  - Pages: sign-in (shows only configured methods), link verification, projects list,
    new project, project overview, live run view (SSE, gaps highlighted, per-step logs),
    settings (members, roles, new org).
  - Dark mode, keyboard focus states, and layouts down to 375 px.
  - Nothing green for an unchecked state: environments read "Not checked" until Pulse
    exists, and a partial run is amber.
- **`e2e/`:** the Phase 1 gate in Chromium against real Postgres, MinIO, the API, the worker
  and web; plus 375 px overflow checks.
- **CI:** an e2e job, an OpenAPI drift check, and integration tests on Testcontainers.

### Deferred or partial

- **Not yet built (Phase 5):** API tokens for the CLI, GitHub App installation, schedules,
  notifications. The UI says so.
- **Logs:** run logs are capped text on `run_steps.log`; there is no separate log storage yet.
- **Org deletion and invitations:** there is no org deletion endpoint. Adding a member creates the user
  row, and they join on first sign-in; there is no invitation email yet.
- **docker-compose:** still runs infrastructure only. api, web and worker run from
  `pnpm start:*`, and containerised app services arrive with the production Dockerfiles
  in Phase 5.
- **Observability:** OpenTelemetry and Sentry wiring is Phase 5. Logs are structured pino
  with cookie and authorization redaction.

### Known risks

- **RLS boundary:** raw SQL inside a tenant transaction could `RESET ROLE`. No tenant path
  builds SQL from input; a separate login role would remove the risk (ADR 0009).
- **Proxy hop:** the web proxy adds a hop to every API call. Revisit if latency matters.

### Gate result

Run from a clean tree (all build outputs and turbo caches deleted) on 2026-10-21:

```
pnpm lint          Checked 198 files. No fixes applied.
pnpm typecheck     Tasks: 30 successful, 30 total
pnpm build         Tasks: 15 successful, 15 total
pnpm test          Tasks: 21 successful, 21 total
  @codesentra/core             45 passed
  @codesentra/config           18 passed
  @codesentra/storage           3 passed
  @codesentra/db               16 passed   (RLS attacks, composite FKs, run lifecycle)
  @codesentra/queue             6 passed   (Postgres + MinIO: live events, idempotency, gap, retries, sweep)
  @codesentra/api              32 passed   (auth, CSRF, GitHub OAuth fake, projects, members,
                                            SSE, 501s, OpenAPI drift, cross-org on every route)
  @codesentra/fixture-harness  42 passed
pnpm e2e           4 passed
  ✓ redirects signed-out visitors to sign-in
  ✓ Phase 1 gate: sign in, create a project, trigger a job and watch its steps live
  ✓ @responsive pages fit a 375 px screen (desktop + mobile projects)
```

The gate test signs in through a real magic link, creates a project, starts a diagnostic,
and sees all steps `pending` with the stream connected. Only then does it start the worker,
and it watches every step turn `done` and the run turn `Succeeded` with no page navigation.

**Phase 1 gate: passed locally.**

## Phase 0 — Fixtures and skeleton (2026-10-21)

### Built

- **Monorepo:** pnpm workspaces, Turborepo, TypeScript strict (TS 7 for packages, TS 6
  for Next apps; ADR 0001), Biome, Vitest.
- **`packages/core`:** all 37 finding codes with declarations; evidence, report and claim
  schemas; canonical JSON and evidence hash; fingerprint normalization; the Pulse status
  rule; the issue re-check lifecycle. 40 unit tests.
- **`packages/config`:** per-service env validation that rejects placeholder and
  malformed values and never echoes secrets, plus a `.env.example` drift test. 12 tests.
- **Fixture apps:** `env-undefined` (broken and fixed variants), `localhost-leak`,
  `broken-route`, `console-throw`, `blank`, `healthy`. All are real Next.js 16 static exports.
- **Fixture harness:** serves every app and 14 simulators (5xx, 404, timeout, slow,
  redirect loop, 5-hop chain, connection refused, DNS failure, five TLS cases). The harness
  test drives real Chromium and confirms each fixture shows exactly its documented defect,
  and that `healthy` shows none.
- **Fixture repos:** `ts-taskboard` (Express/TS) and `py-notes-api` (FastAPI). Their
  `expected.json` covers features with statuses, planted findings with exact lines, routes,
  env vars, probe results and forbidden claims. Install, build, tests and audit were confirmed
  by running each repo in a scratch sandbox. A test keeps every locator pointing at the stated text.
- **`infra/docker-compose.yml`:** Postgres 16.15, MinIO (+ private bucket), and the
  containerised harness. Brought up and verified locally.
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, build + test (including the
  browser fixture gate), compose smoke test, gitleaks.

### Deferred or partial

- `apps/*` and every other package come in Phases 1–5. docker-compose does not list
  services that don't exist yet (Rule 6).
- `infra/sandbox` and `infra/pulse` images come in Phases 3 and 2.
- The `expected` blocks in fixture.json (Pulse status, findings, issues, prompts) are not
  asserted yet; Pulse and Link don't exist. The Phase 2 and 4 gates will assert them.
- `ACCESS_PROTECTED` and `PREVIEW_SERVED_AS_PROD` simulators will be added with the
  platform adapters in Phase 2.
- There is no git-history fixture yet. It will be generated by a script in Phase 3 (ADR 0006).

### Known risks

- **SSRF vs harness:** harness targets are loopback, which Pulse must block. Phase 2 needs
  a test-only allowlist that is impossible to enable in production (ADR 0002).
- **OSV:** `api.osv.dev` was unreachable from the development sandbox. Phase 3 tests need
  an offline advisory snapshot.
- **gVisor:** `runsc` is not installed in the development sandbox. Phase 3 will fall back
  to `runc` and record which runtime was used.
- **MinIO:** upstream images are gone; we use the pinned `pgsty/minio` build (ADR 0004).
- **CI action versions** are pinned to major tags (`checkout@v5`, `setup-node@v5`,
  `pnpm/action-setup@v4`). Pin to SHAs in Phase 5 hardening.

### Gate result

Run from a clean tree (all `dist/`, `out/`, `.next/` and turbo caches deleted) on 2026-10-21:

```
pnpm install --frozen-lockfile   ok
pnpm lint                        Checked 96 files. No fixes applied.
pnpm typecheck                   Tasks: 15 successful, 15 total
pnpm build                       Tasks: 9 successful, 9 total
pnpm test                        Tasks: 9 successful, 9 total
  @codesentra/core               40 passed
  @codesentra/config             12 passed
  @codesentra/fixture-harness    42 passed (manifests, repos, simulators, Chromium self-test of all 7 app variants)
docker compose (fixtures profile) postgres healthy, minio healthy, bucket created, harness serving 6 apps + 14 simulators
gitleaks git . (with .gitleaks.toml)   no leaks found
gitleaks on fixtures/repos (no allowlist)  aws-access-token at py-notes-api scripts/seed.py:6 and ts-taskboard src/config/defaults.ts:4
```

**Phase 0 gate: passed locally, and in CI on santheesh73/Code-Sentra#1 (merged).**
