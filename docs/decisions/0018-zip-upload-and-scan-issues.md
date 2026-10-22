# 0018 — Raw zip uploads, scan caching, and Scan findings before Link

- **Status:** accepted (Phase 3); revisit in Phase 4

## Context

Uploads must not weaken the CSRF defence of ADR 0010: state changes require the app's
Origin and a JSON body. Multipart form posts can be sent cross-site without a preflight.
Separately, Section 10 makes Sentra Link the owner of issues, and Link arrives in Phase 4.

## Decision

- **Upload.** `POST /v1/projects/{id}/snapshots` takes the zip as the raw body with
  `Content-Type: application/zip`.
  - Why this type: no HTML form can send it, and a cross-site `fetch` with it needs a CORS
    preflight, which the API never grants. The Origin check still applies.
  - Size: the body is capped at `SCAN_MAX_UPLOAD_BYTES`, and the magic bytes must say zip.
    The zip limits of ADR 0016 apply at ingest, in the worker.
  - Storage: the archive goes to object storage as `snapshots/{org}/{snapshot}.zip`. Git
    snapshots are archived there after cloning too, so every run's input is kept.
- **Caching.** When ingest finds a finished scan of the same tree hash in the project, the
  new run reuses it:
  - it stores `parent_run_id` and `outcome.cached`, and copies the reused health and counts;
  - its other steps are skipped, with the reason;
  - `GET /v1/runs/{id}/report` serves the reused report, marked `cached`.
- **Scan findings before Link.**
  - Storage: Scan stores evidence and findings with Scan fingerprints.
  - Display: `GET /v1/runs/{id}/findings` groups them into issue drafts with prompts on
    read, as it does for Quick Pulse (ADR 0015).
  - Prompts: a finding with a file and line gets a `code_fix` prompt naming that location,
    and its "how CodeSentra confirms the fix" section names the next Scan. A Pulse finding
    still never gets `code_fix` without a trace.
  - Not yet: Scan does not open stored issues. Opening, re-checking and resolving them
    across Scan and Pulse is Link's job (Phase 4).

## Consequences

- The web uploads with `fetch(..., { body: file })` through the same-origin proxy, which
  streams request bodies.
- In Phase 4, `worker-link` calls the same `draftIssues` and `syncIssues` on Scan
  findings, and Scan issues become stored, re-checked issues.
