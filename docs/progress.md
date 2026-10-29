# Progress

## Phase 11 — Closing the build gaps (2026-10-29)

The user chose to close the build gaps left by Phases 9 and 10 (ADR 0029).

### Built

- **Maven parent POMs are checked before Maven starts.**
  - Our script walks each external parent's chain on Maven Central (sha1-checked) and
    refuses when the build would load a build extension.
  - Extensions are now judged as Maven loads them, so a parent that merely manages one, as
    Spring Boot's does for `native-maven-plugin`, is not a reason. `java-shop-api` checks
    2 parent POMs, then builds and tests as before.
- **Download scripts can refuse at run time.** The probe reports "not downloaded" with
  the reason, not a failed download.
- **Native gems build offline.**
  - The sandbox image adds make, Ruby's headers and the `libruby.so` link name.
  - `rb-notes-api` now locks bcrypt 3.1.22 (a C extension), which compiles in the
    sandbox. Its tests are unchanged: 2 pass, 1 fail, 1 pending.
- **PHP packages from GitLab.com** are downloaded the same way as GitHub ones, as a zip
  pinned to the locked commit. Other hosts get a reason that names the host and what is
  accepted.
- **Phase 10 follow-up:** PR #11's CI ran the PHP download and PHPUnit, and passed. This
  session's egress policy had blocked both.

### Defects found and fixed

- **Over-broad Maven refusal.** The Phase 9 check refused any POM containing
  `<extensions>true</extensions>`, even in `pluginManagement` or an inactive profile, where
  Maven loads nothing. It now follows Maven's rules.
- **Native extensions could not link.** The image had `libruby.so.3.4` but not
  `libruby.so`, so linking failed (`cannot find -lruby`) even with a compiler present.
- **Rate limiting at Central.** Central answers bursts with 429; the parent check backs
  off and retries.

### Still open (needs the user)

Unchanged: the real-GitHub gate, deployment, a real report-model run, gVisor, and npm
publish (plus a license choice).

### Deferred or partial

- **Gradle** still does not build (ADR 0027).
- **Private PHP repositories** and hosts other than GitHub and GitLab.com are refused.
- **cgo** stays off for Go.
- **Maven profile activation** is not evaluated: any `<activation>` counts as active.

### Gate result

Running; replaced with the recorded output once the gate finishes.

## Phase 10 — Rust and PHP (2026-10-29)

The user chose Rust and PHP (ADR 0028).

### Built

- **Parsers** for Rust and PHP, with the same facts as the other languages: imports,
  symbols, routes, env reads, URL literals and env-built URL templates, error messages,
  tests and their skips, TODO markers, and not-implemented stubs. The single-file CLI
  embeds both grammars.
  - Rust routes: axum, Actix and Rocket.
  - PHP routes: Laravel, Slim/Lumen and Symfony `#[Route]`.
- **Map and graph:**
  - Rust `mod`/`use` resolve to module files within each Cargo crate.
  - PHP `use` resolves through composer.json's PSR-4 maps, and `require` against the file.
  - Cargo.toml and composer.json are read as manifests. Axum, Actix Web, Rocket, Laravel,
    Slim and Symfony are detected, and the claim verifier knows their names.
  - Link traces into Rust and PHP routes, and Rocket's `<id>` segments match.
- **Dependency audit:** Cargo.lock (crates.io) and composer.lock (Packagist) against OSV.
- **Probes in the sandbox:**
  - **Rust:** `cargo fetch --locked` from crates.io only, then offline build, Clippy and
    `cargo test`.
  - **PHP:** our script downloads each locked commit zip from GitHub, and Composer does not
    run during the download. Then, offline: the autoloader, `php -l`, and PHPUnit or Pest.
- **Sandbox image:** adds Rust 1.99.0 with Clippy, PHP 8.4.27 and Composer 2.10.3, plus
  the C toolchain Rust links with. It is built without any package mirror.
- **Fixtures:**
  - `rs-notes-api` (axum; smallvec 1.6.0, GHSA-43w2-9j62-hq99) runs in the sandbox: build
    and Clippy pass, tests 2 pass, 1 fail, 1 ignored.
  - `php-notes-api` (Slim; guzzlehttp/psr7 2.4.4, GHSA-wxmh-65f7-jcvw).

### Defects found and fixed

- **A skipped PHPUnit test would have counted as failing.** PHPUnit numbers skipped tests
  the same way as failures (`1) Class::method`), so failing names are now read from the
  failure and error sections only. A test covers it.
- **A dropped database connection could crash a service.** Our Postgres pool had no
  `error` listener. When Postgres ended an idle connection (a restart, a failover,
  `pg_terminate_backend`), the pool's error went unhandled, and Node ends the process on
  that. Found through an API test teardown that failed this way under load: pg-pool's
  `end()` resolves before its connections have closed, and the test database stopped under
  them. Now:
  - the pool reports the error to the service's logger and opens a new connection;
  - `close()` waits for every connection to close.

  Tests in `packages/db/src/pool.test.ts` fail without the fix.
- **Outdated Ruby gap reason.** It said the sandbox has no C compiler. It now has one (for
  Rust), so the reason names what is still missing: make and the Ruby headers.

### Verified here, and what only CI verifies

- This session's egress policy refuses GitHub archive downloads (codeload.github.com,
  api.github.com) and Debian's mirrors.
- Verified here:
  - the Rust fixture end to end in the sandbox;
  - the PHP offline steps (`composer dump-autoload`, `php -l` with a planted syntax
    error);
  - the PHP unpacker against crafted zips (an entry escaping `vendor/`, a symlink, a
    checksum mismatch);
  - every PHP finding that does not need the test run.
- CI only: the PHP download, and so the PHPUnit run and its TESTS_FAILING finding.

### Still open (needs the user)

Unchanged: the real-GitHub gate, deployment, a real report-model run, gVisor, and npm
publish (plus a license choice).

### Deferred or partial

- **Gradle** projects still do not build.
- **PHP packages hosted outside GitHub** (GitLab, Bitbucket, private repositories) are
  refused, so those projects get a gap.
- **Route prefixes outside the syntax** are not applied: Laravel's `routes/api.php`
  prefix, Rocket mounts, and axum routers nested from another function (ADR 0028).
- **Native gems** still need make and Ruby headers. cgo stays off.

### Gate result

Run on this machine on 2026-10-29, after the last code change (sandbox runtime `runc`;
sandbox image with Rust 1.99.0, PHP 8.4.27, Composer 2.10.3, Ruby 3.4.10, Java 21, Maven
3.9.12 and Go 1.27.2).

```
pnpm lint          Checked 766 files. No fixes applied.
pnpm typecheck     Tasks: 61 successful, 61 total
pnpm build         Tasks: 30 successful, 30 total
pnpm test          20 packages, 711 tests: 706 passed, 5 failed (all php-notes-api; see below)
  @codesentra/scan             142 of 147 passed  (Scan gate and sandbox probes; rs-notes-api
                                            end to end)
  @codesentra/fixture-harness   76 passed  @codesentra/parsers  37 passed
  @codesentra/claims            41 passed  @codesentra/link     26 passed
  @codesentra/graph             19 passed  @codesentra/db       30 passed
  (and api 64, ssrf 71, core 70, checks 38, cli 26, config 19, sandbox 10, prompts 10,
   github 9, queue 6, storage 6, notify 3, telemetry 3)
pnpm e2e           17 of 18 passed (10.0m); php-notes-api failed (see below)
CLI tarball        rs-notes-api and php-notes-api: 4 routes and NOTES_SIGNING_KEY each
```

Every failure is `php-notes-api`'s download. This session's egress policy refuses
codeload.github.com, so install fails and PHPUnit never runs. That fails 4 Scan gate
checks, the PHP sandbox probe test and the PHP e2e report. Every other PHP finding was
checked without the sandbox and matched. CI has GitHub access and runs the download.

## Phase 9 — Ruby and Maven builds without code in the download (2026-10-29)

The user chose safe Ruby and Java builds (ADR 0027).

### Built

- **Sandbox image:** adds Ruby 3.4.10 with Bundler and Java 21 with Maven 3.9.12.
- **Ruby:**
  - Gems are downloaded straight from `Gemfile.lock`, by our own script, checked against
    its checksums. The Gemfile is never run during the download.
  - Bundler then installs offline, and RSpec or Minitest runs in the sandbox.
  - `rb-notes-api` now runs: 2 pass, 1 fail, 1 pending.
- **Maven:**
  - The download goes through Maven Central only, with checksums enforced and only
    Maven's own pinned dependency plugin running. The test providers Maven resolves late
    are fetched explicitly.
  - Build extensions are refused and `.mvn/` is set aside.
  - Then, offline: install, package and test.
  - `java-shop-api` now builds and runs its tests: 1 pass, 1 fail, 1 skipped.
- **Sandbox-caused failures are gaps.** A native gem without a C compiler, a pinned Ruby
  the sandbox lacks, an artifact the offline cache missed, or a too-new Java target is
  reported as not run, not as the project failing.

### Defects found and fixed

- **Invalid Ruby fixture lockfile.** `rb-notes-api`'s hand-written `Gemfile.lock` from
  Phase 8 was invalid, and Bundler rejected it. It is regenerated by Bundler, with
  checksums.
- **Tests failing offline.** Offline Maven tests failed until the Surefire provider and
  the JUnit launcher were added to the download, because `go-offline` misses both.

### Still open (needs the user)

Unchanged: the real-GitHub gate, deployment, a real report-model run, gVisor, and npm
publish (plus a license choice).

### Deferred or partial

- **Gradle** projects still do not build, because resolving needs the build script.
- **Parent POM extensions:** a parent POM or BOM from Maven Central could declare build
  extensions, which would run during the download (ADR 0027, Consequences).
- **Native gems and cgo** still need a C toolchain the sandbox does not have.

### Gate result

Run on this machine on 2026-10-29, after the last code change (sandbox runtime `runc`;
sandbox image with Ruby 3.4.10, Java 21, Maven 3.9.12 and Go 1.27.2). CI on the PR head
passed all eight jobs.

```
pnpm lint          Checked 681 files. No fixes applied.
pnpm typecheck     Tasks: 61 successful, 61 total
pnpm build         Tasks: 30 successful, 30 total
pnpm test          20 packages, 656 tests, 0 failed
  @codesentra/scan             118 passed  (Scan gate on 5 fixture repos; Go, Ruby and
                                            Maven probes in the sandbox)
  @codesentra/fixture-harness   64 passed  @codesentra/parsers  33 passed
  @codesentra/claims            39 passed  @codesentra/link     24 passed
  @codesentra/graph             15 passed  (and api 64, ssrf 71, core 70, checks 38, db 28,
                                            cli 26, config 19, sandbox 10, prompts 10,
                                            github 9, queue 6, storage 6, notify 3,
                                            telemetry 3)
pnpm e2e           16 passed (6.5m)
```

## Phase 8 — Go, Ruby and Java (2026-10-28)

The user chose more languages (ADR 0026).

### Built

- **Parsers** for Go, Ruby and Java, with the same facts as TypeScript and Python: imports,
  symbols, routes, env reads, URL literals and env-built URL templates, error messages,
  tests and their skips, TODO markers, and not-implemented stubs. The single-file CLI
  embeds the three grammars.
- **Map and graph:**
  - Go imports resolve by `go.mod` module path, Ruby `require`/`require_relative` resolve
    to files, and Java imports resolve under the source roots.
  - Go and Java test files also count for their own package.
  - `go.mod`, `Gemfile`, `pom.xml` and `build.gradle` are read as text, never run.
  - New frameworks: Gin, Echo, Chi, Fiber, Rails, Sinatra, Spring Boot, Jakarta REST.
- **Dependency audit** for Go, RubyGems and Maven, each with its own version ordering.
- **Go probes in the sandbox:**
  - `go mod download` fetches from the public Go module proxy only, checked against the
    public checksum database.
  - Then, offline: `go mod verify`, `go build`, `go vet` and `go test -json`.
- **Ruby and Maven/Gradle probes are gaps.** Their dependency downloads would run code
  (the Gemfile, build plugins), which ADR 0016 forbids.
- **Fixture repos:** `go-shop-api`, `rb-notes-api` and `java-shop-api`, each with an
  `expected.json` checked by hand and a real advisory in the offline OSV snapshot. All
  five fixture repos pass the Scan gate.

### Defects found and fixed along the way

- **Same-package tests.** A Go or Java test covers its own package without importing it,
  so passing tests never counted as covering. They now do.
- **Framework claims.** The claim verifier did not know Gin, Quarkus and the other new
  names, so "The API uses Gin." verified against a chi project.
- **Spec claims.** "All 3 specs pass." was not read as a test-result claim.
- **Silent audit skips** (in every ecosystem, including npm and PyPI): lockfile entries
  without a pinned version were left out of the audit without a gap. They are now
  reported.

### Still open (needs the user)

Unchanged: the real-GitHub gate, deployment, a real report-model run, gVisor, and npm
publish (plus a license choice).

### Deferred or partial

- **Ruby and JVM builds and tests do not run.** That needs a download path that runs no
  code, such as Bundler's `vendor/cache` or a resolved dependency list for Maven. Each is
  its own decision.
- **Go packages that need cgo fail to build** in the sandbox, which has no C toolchain.
- **Rails `resources` routes** are not expanded. Only explicit verbs and `root` are read.
- **Kotlin, Rust, PHP and C#** are recognized and reported as not parsed.

### Gate result

Run on this machine on 2026-10-28 (sandbox runtime `runc`, Go 1.27.2 in the sandbox image).

The first full run failed three ways:
- **Lint:** ADR 0026 was not yet formatted when the run started.
- **Typecheck:** a type error in the new Link test.
- **e2e:** `java-shop-api`'s report overflowed a 375 px screen. Java paths and Maven
  coordinates are long tokens that did not wrap.

All three are fixed. The phone-width check now names the elements that overflow, and the
issue lists wrap long tokens (`overflow-wrap: anywhere`). Reruns after the fixes:

```
pnpm lint          Checked 680 files. No fixes applied.
pnpm typecheck     Tasks: 61 successful, 61 total
pnpm build         Tasks: 30 successful, 30 total
pnpm test          20 packages, 651 tests, 0 failed
  @codesentra/scan             113 passed  (Scan gate on 5 fixture repos; Go probes in the
                                            sandbox; Go/RubyGems/Maven audit)
  @codesentra/fixture-harness   64 passed  @codesentra/parsers  33 passed
  @codesentra/claims            39 passed  @codesentra/link     24 passed
  @codesentra/graph             15 passed  (and api 64, ssrf 71, core 70, checks 38, db 28,
                                            cli 26, config 19, sandbox 10, prompts 10,
                                            github 9, queue 6, storage 6, notify 3,
                                            telemetry 3)
pnpm e2e           16 passed (2.9m)  (the Phase 3 gate now runs all five fixture repos)
```

## Phase 7 — Hardening and the Phase 6 leftovers (2026-10-28)

The user chose this scope; Section 18 ends at Phase 5 (ADR 0025). I ran the CLI against
every fixture app, every failure simulator and both fixture repositories, and read each
issue, re-check and prompt it produced.

### Fixed

- **Same-code findings were merged into one issue.**
  - Before: one response missing three security headers was one issue, led by the first
    header and listing `MISSING_SECURITY_HEADER` twice as corroboration. Fixing that
    header resolved it, and the other two opened as new issues.
  - Now: only different codes corroborate each other, so each missing header is its own
    issue.
- **Re-checks named the place instead of the thing.** For example, "app/page.tsx:9 is
  documented in .env.example" and "console error https://x/ not logged". Six codes now
  name the env var, test, header or message, clipped to 120 characters.
- **Pulse waited 15 s on pages that ignore a response body.**
  - Cause: Chromium keeps an intercepted response open until the page reads it, so
    `networkidle` never fired.
  - Fix: idle is now measured in Pulse's own request handler. On `env-undefined`, Pulse
    took 15.8 s before and 1.4 s after, with the same findings. A regression test fails
    on the old code.
- **`TLS_EXPIRING` dropped the port** from its locator, so sites on one host with
  different ports shared a fingerprint. Default ports are unaffected.
- **Wording:** "A aws-access-token secret pattern" now reads "A secret matching the
  aws-access-token pattern".

### Looked at, not changed

- **Missed schedule windows** were already caught up with one run; the existing test
  covers six missed windows. The Phase 6 line saying they were "not replayed" was wrong
  and is removed.
- **A diff-only map step** is not worth building. Parsing takes about 1 s per 291 files
  (1.4 MB, measured on this repository). A PR scan's time goes to the dependency
  download, install, build and tests, which must run on the whole tree. The real speedup
  would be a per-org dependency cache keyed by lockfile hash, which needs storage and a
  cache-poisoning review. That is left for your decision.
- **OSV lookups fail in this session** because its network only allows traffic through a
  proxy and the SSRF-pinned fetch connects directly. Scan reports this as a gap.
  Production has no such proxy.

### Still open (needs the user)

Unchanged from Phase 6: the real-GitHub gate, deployment, a real report-model run,
gVisor, and npm publish (plus a license choice).

### Gate result

Run on this machine on 2026-10-28, after the last code change (sandbox runtime `runc`).

```
pnpm lint          1 error in that run: ADR 0025 not yet formatted (written while the gate
                   started). After `biome check --write`: Checked 519 files. No fixes applied.
pnpm typecheck     exit 0
pnpm build         Tasks: 30 successful, 30 total
pnpm test          20 packages, 568 tests, 0 failed
  @codesentra/core     70 passed  (same-code split, discriminator re-checks)
  @codesentra/checks   38 passed  (network idle with an unread body; TLS endpoint port)
  @codesentra/api      64 passed  @codesentra/scan  66 passed  @codesentra/ssrf  71 passed
  (and fixture-harness 46, claims 36, db 28, cli 26, parsers 26, link 21, config 19,
   graph 10, prompts 10, sandbox 10, github 9, queue 6, storage 6, notify 3, telemetry 3)
pnpm e2e           13 passed (2.0m, previously 2.8m)
```

## Phase 6 — Closing the Phase 1–5 gaps (2026-10-28)

Section 18 stops at Phase 5. Phase 6 is the gaps from earlier entries that need no outside
account (ADR 0024).

### Built

- **One issue per env var.** A Scan `ENV_VAR_UNDOCUMENTED` finding at a Pulse issue's
  trace site, for the same env var, joins that issue as a corroborating code instead of
  opening a second issue (`mergeEnvFindings`, `packages/link`).
- **Scheduled full checks.** Schedules run `pulse` or `check` (migration `0013`). A check
  schedule, `/check` and Scan re-checks scan the linked GitHub repository at the default
  branch's head, else `repo_url`; with neither, the gap is recorded.
- **GitHub snapshots with history.** worker-scan clones the commit with the installation
  token (passed in `GIT_CONFIG_*`, never argv) through the SSRF pin. If the clone fails,
  it falls back to the zipball and records the history gap with git's reason. The fake
  GitHub now serves real repositories over git smart HTTP.
- **Direct uploads.** Browsers upload zips straight to storage under a presigned POST
  (key, type and size pinned). The API checks the object before it can be scanned, so
  Vercel's 4.5 MB proxy limit no longer applies to uploads. The proxy upload remains as
  the fallback.
- **`ENCRYPTION_KEY` rotation.** Sealed values carry a key id, `ENCRYPTION_KEY_PREVIOUS`
  keeps old keys readable, and `reseal-cli` moves every sealed column to the current key
  (runbook §8).
- **Link progress.** A full check's live stream includes its child Scan and Pulse runs.
- **Org lifecycle.** Adding a member sends an invitation email. Owners can delete an org
  (confirmed by its slug). Deletion removes every tenant row and the org's stored objects,
  and is logged.
- **The whole app in docker-compose.** `pnpm stack:up` runs migrate, the API, the three
  workers and the web app. CI brings the stack up and checks health, sign-in email and
  every worker.
- **Single-file CLI.** `apps/cli/dist/npm/` holds the CLI as one file (grammars embedded)
  plus a manifest whose only dependency is `playwright-core`. CI installs the packed
  tarball and runs a scan with it.

### Decisions

- ADR 0024: what Phase 6 covers, and how each gap is closed.

### Still open (needs the user)

- **The real-GitHub gate** (runbook §7): needs a GitHub App, a test repository and
  hosting.
- **Deployment:** nothing is deployed. Render, Vercel and the worker-scan VM need your
  accounts, and no deploy happens without your go-ahead.
- **A real report-model run:** needs `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. The
  inventory and report prose are tested against a scripted model only.
- **gVisor:** sandboxes run on runc here and in CI; `runsc` needs the VM in
  `infra/deploy/`.
- **npm publish** (runbook §9): needs an npm account and a license choice. The manifest
  says `UNLICENSED`.
- **The worker-scan image** still cannot be built in this session, because the Debian
  mirrors are blocked here. CI's `images` and `compose` jobs build it.

### Deferred or partial

- `scan.incremental` still scans the whole head tree (cached by tree hash).
- Only the env-var pair is merged across Pulse and Scan. Other pairs need an equally
  exact rule.

### Gate result

Run on this machine on 2026-10-28, after the last code change (sandbox runtime `runc`;
the GitHub flow runs against the local fake). CI has not yet run these commits.

```
pnpm lint          Checked 518 files. No fixes applied.
pnpm typecheck     exit 0
pnpm build         Tasks: 30 successful, 30 total
pnpm test          20 packages, 563 tests, 0 failed
  @codesentra/api      64 passed  (uploads, org lifecycle, Link child progress, GitHub
                                   clone with history, cross-org on every route)
  @codesentra/scan     66 passed  @codesentra/link     21 passed (env-var merge)
  @codesentra/core     67 passed  (key rotation)       @codesentra/db 28 passed (reseal)
  @codesentra/storage   6 passed  (presigned policy against real MinIO)
  (and ssrf 71, fixture-harness 46, checks 36, claims 36, cli 26, parsers 26, config 19,
   graph 10, prompts 10, sandbox 10, github 9, queue 6, notify 3, telemetry 3)
pnpm e2e           13 passed (2.8m)  (Phase 1–4 gates, a browser uploads straight to
                                      MinIO, and the Phase 5 settings spec)
```

Also checked by hand here:
- the compose stack (`pnpm stack:up`): health through the web proxy, the sign-in email
  in the outbox, and the workers' `ready` lines (worker-scan was not built; see above);
- the packed CLI tarball installed outside the repository: a scan extracts env vars, and
  Pulse renders a page in Chromium.

## Phase 5 — GitHub, schedules and hardening (2026-10-28)

### Built

- **GitHub App (ADR 0021).**
  - `packages/github`: App JWT, cached installation tokens, check runs, compare, zipballs
    (size-capped), and the OAuth proof that a user can access an installation.
  - `POST /v1/webhooks/github`: the signature is checked over the raw bytes; each
    delivery is processed once (a failed one can be redelivered). It handles
    `installation`, `installation_repositories`, `pull_request`, `deployment_status` and
    `push`.
  - Pull requests: a `github` snapshot of the head commit → `scan.incremental` → Link in
    PR mode → one "CodeSentra" check run per (project, head SHA).
  - Deployments: preview deployments run Pulse into the same check run, traced against
    the commit's Scan. Production deployments and default-branch pushes
    (`check_on_push`) update the project's issues.
  - Installation linking needs a signed state plus GitHub's confirmation that the user
    can access the installation. Installation data is sealed at rest.
- **PR mode.** A branch never opens or resolves project issues. Its check reports the
  drafts that are not already open, with Scan findings limited to the changed files and
  their blast radius. The check-run text holds each issue's prompt.
- **Schedules (ADR 0022).** Recurring Pulse with five-field UTC cron (pure parser in
  core), at least 5 minutes apart. worker-link's ticker claims due schedules with
  `SKIP LOCKED`.
- **Alerts.** `packages/notify` renders one alert per run (email text/HTML and Slack
  blocks), each issue with its prompt. Link sends it after a sync run opens or regresses
  issues.
  - Email channels go to org members only.
  - Slack is added by OAuth only.
  - Destinations are sealed at rest.
- **API tokens + CLI.**
  - `cs_…` tokens are bound to one org, stored as sha256 only, expire in 90 days, and
    their creation and revocation are audited.
  - `codesentra login` verifies the token and stores it with mode 0600.
  - `codesentra check --project <id> [--wait]` uses the Section 15 exit codes, and its
    runs have trigger `cli`.
- **Protected previews.** Per-environment bypass tokens are sealed, set by admins only,
  never returned, and never recorded in evidence. The Pulse job uses them.
- **Section 17 hardening** (mapped item by item in `docs/security.md`):
  - run limits per org, user, run type and target host (429 + `Retry-After`);
  - an audit-log endpoint;
  - a test that no secret reaches the report model;
  - CI dependency scanning (`pnpm audit`) and image scanning (Trivy, pinned by digest).
- **Observability (ADR 0023).** `packages/telemetry`:
  - API handlers, jobs and every worker step are spans;
  - one trace runs API → queue → worker through `traceparent` in the job payload;
  - Sentry gets final job failures and API 5xx, scrubbed of bodies, cookies and auth.
- **Production images and deployment config:**
  - images: `infra/node` (API, worker-link) and `infra/scan` (worker-scan), all non-root;
  - `render.yaml` (no auto-deploy), `apps/web/vercel.json`,
    `infra/deploy/worker-scan.compose.yml`;
  - `docs/runbook.md`.
- **Web.**
  - Org settings: GitHub App, API tokens (shown once), audit log.
  - Project settings: repository binding, bypass tokens, schedules, email and Slack
    channels.
  - The API proxy forwards `Authorization` and GitHub's webhook headers.

### Decisions

- ADR 0021: GitHub snapshots, PR mode, one check run per commit, installation-scoped
  routing.
- ADR 0022: the scheduler is a ticker; `startLinked` moves to `packages/queue`; alerts come
  from Link; tokens are org-bound; limits are counted from `runs`.
- ADR 0023: spans without auto-instrumentation; Sentry for errors only; image layout and
  the deployment topology.

### Deferred or partial

- **The real-GitHub gate has not been run.** It needs a GitHub App, a test repository with
  preview deployments, and hosting (`docs/runbook.md` §7). CI runs the same flow against a
  local fake of the GitHub API.
- **Nothing is deployed.** The configs are written but untested on Render and Vercel.
  Render passing `SERVICE` to the Docker build, and `generateValue` producing a valid
  `ENCRYPTION_KEY`, are to be confirmed on the first deploy.
- **The worker-scan image's apt step** could not run here: this session's network blocks
  the Debian mirrors. The CI `images` job builds and checks it.
- **`ENCRYPTION_KEY` rotation** needs a re-seal command, which does not exist yet.
- **`scan.incremental`** scans the whole head tree (cached by tree hash). Only Link's
  reporting is incremental.
- **Snapshots from GitHub have no git history,** so history-based checks are gaps for them.
- **Schedules** are Pulse only (Section 12). A missed window is not replayed.

### Known risks

- **Vercel's 4.5 MB request limit** applies to the web proxy. Large zip uploads and GitHub
  push payloads must go to the API's own URL (the runbook points the webhook there).
- **Managed Postgres may refuse `CREATE ROLE`.** The runbook gives the one-time admin
  statement.
- **Bursts of webhooks for one org can hit the per-org run limit.** Those deliveries fail
  with 429 and must be redelivered from GitHub.

### Gate result

The automated part of the gate runs in CI. Run after the last code change, on 2026-10-28:

```
pnpm lint          Checked 506 files. No fixes applied.
pnpm typecheck     Tasks: 61 successful, 61 total
pnpm build         Tasks: 30 successful, 30 total
pnpm test          20 packages, 547 tests, 0 failed
  @codesentra/api              58 passed   (incl. the Phase 5 gate below; schedules, alerts,
                                            tokens, limits, bypass tokens, tracing; cross-org
                                            on every route)
  @codesentra/scan             64 passed   (incl. "no secret reaches the report model")
  @codesentra/ssrf             71 passed   @codesentra/core      65 passed
  @codesentra/fixture-harness  46 passed   @codesentra/cli       26 passed
  (and config, parsers, storage, telemetry, sandbox, notify, prompts, claims, graph,
   db, github, queue, link, checks)
pnpm e2e           13 passed   (Phase 1–4 gates and the Phase 5 settings spec)
```

- **Gate, part 1** (`apps/api/src/__tests__/github.test.ts`, against a local fake of the
  GitHub API and the real fixture apps in Chromium):
  - A pull request introducing `env-undefined` gets a CodeSentra check that ends
    `failure`, titled "Degraded", once its preview deployment is checked. Its text holds
    the `UNDEFINED_IN_URL` issue with the `code_fix` prompt naming `NEXT_PUBLIC_API_URL`
    and `app/page.tsx:9`.
  - The follow-up commit that fixes it gets a `success` check ("Live").
  - The project's issues are untouched.
- **Gate, part 2:** the Section 17 checklist is ticked item by item, with the enforcing
  code and tests, in `docs/security.md`.
- **Not run:** the same flow on real GitHub with real preview deployments (runbook §7).
  It needs the GitHub App credentials, a test repository and hosting, which only the
  project owner can provide. **Phase 5 is complete in CI but not yet verified on real
  GitHub.**

## Phase 4 — Sentra Link (2026-10-22)

### Built

- **Code facts (ADR 0020).**
  - Parsers record `href` values, error messages (throw/Error/console.error, Python
    raise) and the default export. URL literals keep their line text.
  - The graph stores them as `literal` nodes. Next.js routes point at the page
    component, and co-change pairs become edges.
- **`packages/link`** (pure functions):
  - exact-join trace rules for every Pulse code, plus Scan locators;
  - `ROUTE_BROKEN` / `SAME_ORIGIN_FAILURE` with no route are reclassified to
    `ROUTE_MISSING` and traced to the href;
  - for each site: the enclosing symbol, the source line, and the env vars with
    whether they are documented;
  - blast radius: 2 hops of importers plus the top 5 co-change partners, with reasons.
- **`code_fix@2` prompts** for traced issues. They contain:
  - the confirm-first instruction and the exact observation;
  - each site with file, line, symbol and source line;
  - the env vars involved, whether `.env.example` documents them, and the build-time
    guidance with the platform hint;
  - the blast radius.
- **Link runs (ADR 0019).**
  - Every project Scan and Pulse run (and every check or re-check) feeds a `link` run.
    The queue's completion hook enqueues it once all children have finished.
  - `link.run` (`apps/worker-link`) runs trace → widen → prompt → verify and is now the
    only writer of issues. It stores traces (a new `traces` table under RLS) and the
    blast radius.
  - A missing Scan or a failed child is a gap: the Link run is `partial`.
- **Pulse:**
  - probes the latest Scan's static GET routes;
  - `recheck` runs execute only the issue's check group;
  - no longer syncs issues itself.
- **API:**
  - `POST /v1/projects/{id}/check`;
  - `POST /v1/issues/{id}/recheck`;
  - `/pulse` and `/scan` return `link_run_id`;
  - runs carry `parent_run_id`, and Link runs list `children`;
  - issue detail has `traces` and `blast_radius`.
- **Web:**
  - a "Run full check" button;
  - the Link run page (children, outcome);
  - the issue view's "Where it comes from": file:line, symbol, source line, join key,
    env vars and blast radius;
  - "Re-check now".
- **Fixes found on the way:**
  - The `?source=` issue filter answered 500 (an array bound into `= any(...)`).
  - Link ignored a Scan whose model stage failed, even though its graph and findings were
    stored. Usable now means "stored its results".
  - An SSE test asserted a millisecond-long timing window. It failed twice under full-suite
    load and now asserts monotonic progress instead.

### Gate output (2026-10-22, this machine)

```
pnpm lint / typecheck / build          clean
pnpm test                              all packages pass:
  link 15 (incl. real-Pulse traces of all 5 fixture apps to their manifest file:line)
  api 46 (incl. the API-level Phase 4 gate and cross-org on /check and /recheck)
  parsers 26 · prompts 10 · checks 36 · scan 64 · db 27 · queue 6 · core 57 · ssrf 71 ·
  claims 36 · graph 10 · sandbox 10 · cli 20 · config 19 · storage 3 · harness 44
  (api's SSE test failed once in this full run on the old timing assertion; fixed above,
   the api suite then passed 46/46, and api.test.ts 3/3 runs)
pnpm e2e                               12 passed (Phase 1–4 gates; desktop + 375 px)
```

The Phase 4 e2e gate drives the UI on `env-undefined`:
1. Upload the app's source and click "Run full check": Scan, then Pulse in Chromium,
   then Link (trace, widen, prompt, verify all `done`).
2. Exactly one Pulse issue: `UNDEFINED_IN_URL`, corroborated by `SAME_ORIGIN_FAILURE`.
   The view shows the trace `app/page.tsx:9` (`process.env.NEXT_PUBLIC_API_URL}/api/ping`,
   env var `NEXT_PUBLIC_API_URL` not in .env.example). The prompt is `code_fix` and names
   `NEXT_PUBLIC_API_URL` and `app/page.tsx:9`.
3. Serve the fixed build and click "Check production now": the issue becomes `resolved`
   with no manual action.
4. Serve the broken build again and click "Re-check now" (a render-only re-check): the
   issue becomes `regressed`, and its history reads opened → resolved → regressed.

The API-level gate (`apps/api/src/__tests__/link.test.ts`) asserts the same flow. It also
checks the stored Scan issue (`ENV_VAR_UNDOCUMENTED` at `app/page.tsx:9`) and that a
re-check never changes the environment's badge.

**Phase 4 gate: passed locally.**

### Deferred or partial

- **No LLM in Link.** Prompts are templates (Section 10c). Link's only model-shaped work
  would be report prose, which is Scan's. With no `ANTHROPIC_API_KEY` here, a real-model
  run is still untested (as in Phase 3).
- **CLI `check` and `login` move to Phase 5** with API tokens (Settings). `codesentra scan`
  and `pulse` are unchanged.
- **Trace coverage.** The rules see only literal facts. A URL built from several
  variables with no static suffix, or a message assembled at runtime, stays untraced and
  gets an `investigate` prompt. That is by design: no guessing.
- **Child progress.** The Link run's stream carries only its own events, so its page
  polls the children (every 2 s) while they run.
- **Scan re-checks** need `repo_url`. For zip-only projects, the API asks for a new upload.
- **Cross-module merging:** a Pulse issue and a Scan finding about the same env var stay
  two issues. The `code_fix` prompt says whether the variable is documented.

## Phase 3 — Sentra Scan (2026-10-22)

### Built

- **`packages/parsers`:** web-tree-sitter 0.27.1 with the official TypeScript, TSX,
  JavaScript and Python grammars. For each file it extracts imports, exports, symbols,
  routes (Express/Fastify/Koa-style calls, FastAPI/Flask decorators), CLI commands, env-var reads, TODO/FIXME
  markers, stubs and tests (with skips).
- **`packages/graph`:**
  - The code graph: files, symbols, routes, handlers, env vars and tests; edges for
    imports, calls, `defines_route`, `reads_env`, `tests` and `co_changes`.
  - Module resolution, including Python package members.
  - History: churn, contributors, co-change pairs and top-decile hotspots.
- **`packages/sandbox`** (ADR 0016): Docker with `runsc` when present, else `runc`.
  - Isolation: no network, read-only root, `cap-drop ALL`, no-new-privileges, uid 10001,
    pid/CPU/memory limits.
  - Network only for a separate dependency fetch step that runs no project code.
  - `infra/sandbox/Dockerfile`.
- **`packages/claims`:** the claim verifier.
  - Every claim must cite evidence of this run.
  - Each concrete token and number must appear in the cited evidence.
  - Status words must match the evidence-based feature status.
  - Results of checks that did not run cannot be asserted.
- **`packages/core`:** the Section 8a health score, with renormalization when a component
  could not be measured. Every deduction lists its evidence.
- **`packages/scan`:**
  - Ingest: zip with safety limits, or git through the SSRF pin; tree hash.
  - Map: manifests, docs, the graph, routes, env vars, markers, tests and language coverage.
  - History.
  - Probe: install, build, typecheck, lint and tests in the sandbox. Output parsers for
    node:test, vitest, jest, mocha and pytest.
  - Dependency audit: npm and PyPI lockfiles against OSV, with offline-snapshot coverage.
  - gitleaks, with masked previews.
  - Inventory: model-proposed features, with statuses set by rules.
  - Explain: the report model, then the verifier.
  - `./job` is the `scan.run` handler. It reuses a scan of an identical tree.
- **`packages/db`:** `snapshots`, `code_nodes`, `code_edges`, `features`, `reports`, `claims`
  (a dropped claim must have a reason), all under RLS; `runs.snapshot_id`.
- **`apps/worker-scan`:** `scan.run`, with one step per stage (live over SSE). The report
  model is Anthropic when configured, else a gap. `SCAN_TEST_MODEL=fixture` works only
  under `NODE_ENV=test` (ADR 0017).
- **`apps/api`** (ADR 0018):
  - `POST /v1/projects/{id}/snapshots`: a raw `application/zip` body, or a public https git ref.
  - `POST /v1/projects/{id}/scan` answers 202.
  - `GET /v1/runs/{id}/report`: verified sections with evidence ids, features, the health
    breakdown, dropped claims with reasons, and coverage.
  - Projects carry `latest_scan`.
  - Cross-org tests cover the new routes.
  - Fix: `docs/openapi.json` has had no component schemas since Phase 1, so every `$ref`
    dangled. The 42 schemas are now emitted, and a test checks that every reference
    resolves.
- **`packages/prompts`:** `code_fix@1`, for findings with a file and line. Scan findings now
  get prompts in `GET /v1/runs/{id}/findings`. Before this, that route failed for scan runs.
- **`apps/web`:**
  - The run page shows the Scan report:
    - the health breakdown with cited deductions;
    - verified sections, each claim with evidence links;
    - the feature inventory with status chips;
    - the dropped claims and why;
    - gaps, project facts, and issues with prompts.
  - Project page: a Scan card (zip upload or "Scan repository") with the latest summary,
    features and health.
  - Projects list: the health score.
- **`apps/cli`:** `codesentra scan [path|git-url] [--json] [--fix-prompt]` runs in-process,
  with the same sandbox, OSV and model rules. It exits 1 on error findings or anything not
  checked.
- **CI:** builds the sandbox image and pulls gitleaks for the test and e2e jobs. Turbo
  passes `SANDBOX_*` through to the tests.

### Gate output (2026-10-22, this machine; sandbox runtime `runc`)

```
pnpm lint / typecheck / build                  clean
pnpm test                                      all packages pass, including:
  sandbox safety suite                         10 passed (no network, read-only root,
                                               caps dropped, limits, no env leak, …)
  zip + git ingest safety suite                24 passed (traversal, symlinks, bombs,
                                               encrypted, limits; SSRF-pinned clone)
  claims (adversarial suite)                   36 passed: 23/23 fabrications dropped (100%),
                                               10/10 true claims kept
  scan (gate + probes + audit + ingest)        64 passed
  db 27 · api 43 (incl. Scan API + cross-org)  · cli 20 · prompts 9 · core 57 · …
pnpm e2e                                       11 passed (Phase 1–3 gates; desktop + 375 px)
```

Per fixture repo (real sandbox, real gitleaks, the offline OSV snapshot, the scripted
fixture model):

|                               | ts-taskboard                                                                                                                                                                                                            | py-notes-api                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Health                        | 80                                                                                                                                                                                                                      | 78                                                                                                                                |
| Probes                        | install ✓, build ✓, typecheck ✓, tests 2 pass / 1 fail / 1 skip; lint not checked (no script)                                                                                                                           | install ✓, tests 2 / 1 / 1; typecheck and lint not checked (no tools in requirements)                                             |
| Features                      | Create tasks, List tasks **complete**; Mark tasks done, Export tasks to CSV **partial**; Email reminders **planned**                                                                                                    | Create notes, List notes **complete**; Search notes, Export a note as Markdown **partial**; Share notes via link **planned**      |
| Findings at expected locators | TESTS_FAILING, SKIPPED_TESTS, TODO_MARKER, STUB_IMPLEMENTATION, ENV_VAR_UNDOCUMENTED, ENV_VAR_UNUSED, SECRET_EXPOSED (aws-access-token, value never stored), VULNERABLE_DEPENDENCY lodash 4.17.15 (GHSA-p6mc-m468-83gw) | the same set; VULNERABLE_DEPENDENCY jinja2 3.1.2, plus a real pytest 8.3.4 advisory (GHSA-6w46-j5rx-g56g) in requirements-dev.txt |
| Claims                        | 16 drafted, 9 verified, **7/7 forbidden dropped**                                                                                                                                                                       | 16 drafted, 9 verified, **7/7 forbidden dropped**                                                                                 |
| Gaps                          | history (zip), lint                                                                                                                                                                                                     | history (zip), typecheck, lint, transitive deps (requirements pin direct deps only)                                               |

The e2e gate runs both repos through the web: zip upload → API → MinIO → worker-scan →
report page. The page and API must match `expected.json` (features, statuses, findings,
absent findings). No forbidden claim may be shown. Every dropped claim must be listed
with a reason. A secret's value must never reach the API or the page.

**Phase 3 gate: passed locally.**

### Deferred or partial

- **No real-model run.** No `ANTHROPIC_API_KEY` is available here, so Inventory and Explain
  were exercised only with the scripted fixture model (ADR 0017). `anthropicModel` is
  built and type-checked against SDK 1.1.0, but it has not called the API. Without a key,
  both stages are reported as gaps.
- **gVisor.** Neither this machine nor the CI runners have `runsc`, so the sandbox ran on
  `runc` with the same isolation flags. Production should install gVisor and set
  `SANDBOX_RUNTIME=runsc`, which refuses to fall back.
- **Scan issues.** Scan findings get prompts on read (ADR 0018) but are not stored as issues.
  Opening, re-checking and resolving them is Link's job (Phase 4), as is the trace for
  Pulse `code_fix` prompts.
- **Git scans through the stack.** The clone path (SSRF pin, hardened config, a smart-HTTP
  test server) and History are tested in `packages/scan`. The API and e2e tests scan
  zips. A git scan through worker-scan is covered only by the shared ingest code.
- **Private repositories, `scan.incremental` and PR check runs** need the GitHub App
  (Phase 5).
- **Typecheck and lint probes** run only when the project declares the tool. Otherwise
  they are gaps.

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

| App              | Variant | Status   | Findings                                                            |
| ---------------- | ------- | -------- | ------------------------------------------------------------------- |
| `healthy`        | default | live     | none (zero issues)                                                  |
| `env-undefined`  | broken  | degraded | `UNDEFINED_IN_URL` and `SAME_ORIGIN_FAILURE`, merged into one issue |
| `env-undefined`  | fixed   | live     | none                                                                |
| `blank`          | default | degraded | `BLANK_PAGE`                                                        |
| `broken-route`   | default | degraded | `ROUTE_BROKEN`                                                      |
| `console-throw`  | default | degraded | `UNCAUGHT_EXCEPTION`                                                |
| `localhost-leak` | default | degraded | `LOCALHOST_CALL`                                                    |

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
