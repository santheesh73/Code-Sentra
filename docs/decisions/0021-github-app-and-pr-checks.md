# 0021 — GitHub App: commit snapshots, PR-mode Link runs and one check run per commit

- **Status:** accepted (Phase 5)

## Context

Section 16 wants CodeSentra on pull requests and deployments:
- a `pull_request` runs an incremental Scan and reports new issues and at-risk files in a
  "CodeSentra" check run;
- a successful `deployment_status` runs Pulse and updates the same check run, matched by
  head SHA;
- a default-branch `push` can run a full check;
- deliveries are deduplicated.

A branch is not the product. If a pull request could resolve or open project issues,
every abandoned branch would rewrite the project's history.

## Decision

- **Commit snapshots.** A new snapshot kind, `github`, has `source_url` = `owner/repo`,
  `ref` = the commit SHA and the installation id.
  - The scan worker downloads the zipball with an installation token. Only the API host
    is called; the one redirect to the download host is followed, and the archive is
    size-capped.
  - The archive is extracted under the same limits as a zip upload, and GitHub's single
    top directory is stripped.
  - There is no git history (the zipball has none), so history-based checks are gaps for
    these snapshots.
- **`scan.incremental` is the same Scan job.** The Scan cache is keyed by tree hash, so an
  unchanged tree is not scanned twice. The incremental part is in Link: in PR mode, Scan
  findings count only in the changed files (from the compare API) and their blast radius.
- **PR mode.** A Link run whose outcome starts as `{ mode: "pr", changed_files }` builds
  its drafts, traces and prompts as usual but never calls `syncIssues`. It reports the
  drafts whose fingerprint is not already an open or regressed project issue. Pull
  requests and non-production deployments use PR mode. Production deployments and
  default-branch pushes (`check_on_push`) use the normal sync mode.
- **One check run per (project, head SHA)** is kept in `github_check_runs`.
  - The webhook creates or updates the row inside the same transaction that creates the
    Link run, so Link always finds it, and marks the check `in_progress`.
  - Link completes the check run: its conclusion follows Section 16 (`conclusionFor`), and
    its text gives each new issue with its prompt (`checkRunReport`).
  - A deployment's Link run also loads the commit's Scan (`scan_run_id` on the row), so a
    Pulse finding is traced into the PR's code.
- **Routing is by installation.** A webhook acts only on projects whose `github_repo`
  matches the repository and whose org linked that installation. A repository in someone
  else's installation cannot reach your projects.
- **Linking is proven, not claimed.** The `installation_id` in GitHub's setup redirect is
  untrusted. `/v1/github/setup` accepts it only if:
  - the signed state (HMAC with `SESSION_SECRET`, 15 minutes) names the current user and
    an org they administer; and
  - the user-authorization `code` exchanged with the App's OAuth client shows, through
    `GET /user/installations`, that this user can access the installation.
- **At rest:**
  - Installation data (account, repositories) is sealed with AES-256-GCM (`sealSecret`,
    purpose `github-installation`).
  - `webhook_deliveries` (unique `X-GitHub-Delivery`) is system-only.
  - `github_installations` is readable by its own org only.
- **Verification:** the webhook verifies `X-Hub-Signature-256` over the exact received
  bytes with a constant-time comparison before parsing anything else. It answers 501 when
  the App is not configured.

## Consequences

- PR checks never change the project's issue history. The production deployment after the
  merge does that.
- The check run is green before any deployment when the Scan finds no new error issues.
  Its summary says the deployment is "not checked yet". The deployment's Pulse can still
  turn it red.
- Tests and the CI gate use a local fake of the GitHub API (`startFakeGithubApp`). The
  real-GitHub run is in the runbook and needs the App's credentials.
