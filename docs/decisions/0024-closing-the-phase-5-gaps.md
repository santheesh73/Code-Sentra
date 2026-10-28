# 0024 — Phase 6: closing the gaps left by Phases 1–5

- **Status:** accepted (Phase 6)

## Context

Section 18 ends at Phase 5. Its progress entry and earlier entries list gaps that need no
outside account to close:
- Pulse's `UNDEFINED_IN_URL` and Scan's `ENV_VAR_UNDOCUMENTED` describe one env var as two
  issues.
- Schedules run Pulse only, and full checks of a GitHub project had nothing to scan.
- GitHub snapshots have no history.
- Zip uploads pass through the web proxy, so Vercel's 4.5 MB limit applies.
- `ENCRYPTION_KEY` cannot be rotated.
- A Link run's live progress stops at its own steps.
- Orgs cannot be deleted, and members are added without being told.
- docker-compose starts infrastructure only.
- The CLI runs only from a checkout.

Phase 6 is defined as closing these gaps. Its gate is the repository's own suite plus the
new tests named below. Anything that needs the user's credentials stays open.

## Decision

- **One issue per env var.** In the prompt step, Link merges an `ENV_VAR_UNDOCUMENTED`
  finding into the Pulse issue it explains (`mergeEnvFindings`, `packages/link`). The
  merge needs three things:
  - the env var appears in the Pulse trace's `envVars`;
  - the finding's file is a trace site;
  - the finding is not already an open issue of its own.
    The Scan code becomes a corroborating code, and the finding joins the issue's findings.
    Nothing else is merged: other pairs need a rule as exact as this one.
- **Scheduled full checks.**
  - `schedules.run_type` is `pulse` or `check` (migration `0013`).
  - A `check` schedule starts a Link run with a Scan child plus one Pulse child per
    environment.
  - The Scan source (`createSourceSnapshot`, `packages/queue`) is:
    - the linked GitHub repository at its default branch's head;
    - else `repo_url`;
    - else no Scan, recorded as a gap.
  - `/check` and Scan re-checks use the same source.
- **GitHub snapshots with history.**
  - worker-scan clones the commit over git smart HTTP with the installation token.
  - The token is passed as an `http.extraHeader` through `GIT_CONFIG_*` environment
    variables, never argv, and the clone keeps the SSRF pin.
  - It runs `init`, then `fetch --depth <max> <sha>`, then `checkout`.
  - If the clone fails, worker-scan falls back to the zipball and records the history gap
    with git's reason.
  - The fake GitHub serves real repositories through `git http-backend`, so the test
    clones real commits.
- **Direct uploads.**
  - `POST /v1/projects/{id}/uploads` returns a presigned POST whose policy pins the key,
    `Content-Type: application/zip` and `content-length-range` ≤ `SCAN_MAX_UPLOAD_BYTES`.
  - `.../uploads/{snapshotId}/complete` checks the stored size and the zip magic bytes,
    deletes a rejected object, and only then makes the snapshot scannable.
  - The browser uses this flow and falls back to the proxy upload when the API answers
    501.
  - `S3_PUBLIC_ENDPOINT` is the address browsers reach.
- **Key rotation.**
  - Sealed values are `v2.<kid>.<iv>.<tag>.<ct>`, where `kid` is a hash prefix of the key.
  - The keyring is `ENCRYPTION_KEY` (seals) plus `ENCRYPTION_KEY_PREVIOUS` (opens only),
    and v1 values still open.
  - `reseal-cli` rewrites every sealed column under the current key and exits 1, listing
    row ids, if any value fails to open (runbook).
- **Link progress.** `GET /v1/runs/{id}/stream` also subscribes to the run's children, so
  a full check's page moves while Scan and Pulse work.
- **Org lifecycle.**
  - Adding a member emails an invitation, and the response says whether it was sent.
  - `DELETE /v1/orgs/{id}` is owner-only and session-only. It needs the slug as
    confirmation and refuses a user's only org.
  - Deletion cascades every tenant table, deletes the org's objects in storage, and writes
    a structured audit log line, because the org's own audit rows are deleted with it.
- **The whole app in compose.** Profile `app` adds migrate, api, worker-link,
  worker-pulse, worker-scan (runc, through the host's Docker socket) and web, with
  `pnpm stack:up` / `stack:down`. CI brings the stack up and checks:
  - health through the web proxy;
  - a sign-in email in the outbox;
  - every worker's `ready` line.
- **Single-file CLI.**
  - esbuild bundles the CLI with the tree-sitter grammars embedded (`useEmbeddedWasm`) into
    `apps/cli/dist/npm/`: one file plus a manifest whose only dependency is
    `playwright-core`.
  - Without playwright-core, Pulse records the render group as a gap.
  - CI packs the tarball, installs it, and checks that a scan still extracts env vars.

## Consequences

- Deleting an org cannot be undone; the confirmation is the only guard. Its audit trail
  lives in logs, not the database.
- A bucket CORS rule is needed for browser uploads in production (runbook). Without one,
  uploads fail in the browser, not on the server.
- Still blocked on the user, and listed in `docs/progress.md`:
  - the real-GitHub gate;
  - any deployment;
  - a real report-model run;
  - gVisor;
  - publishing the CLI to npm, which also needs a license decision (the manifest says
    `UNLICENSED`).
