# 0015 — Pulse issues are synced by the Pulse worker until Link exists

- **Status:** superseded by ADR 0019 (Phase 4): issues are synced by Sentra Link

## Context

Section 10 puts issue grouping, fingerprints, re-checks and prompts in Sentra Link
(`worker-link`), which arrives in Phase 4. The Phase 2 gate already requires that every
issue has a prompt and is re-checked.

## Decision

- The pure parts live in packages:
  - `groupFindings` and `recheckFor` in `packages/core`: merging by shared evidence, with
    the highest-specificity code leading;
  - `draftIssues` and `findingFingerprint` in `packages/checks`;
  - versioned templates in `packages/prompts`;
  - `syncIssues` in `packages/db`.
- `worker-pulse` runs them in the run's final `issues` step, in the same tenant
  transaction model as everything else. Quick Pulse runs have no project, so they store
  findings and evidence but no issues. Their prompts are rendered on read by
  `GET /v1/runs/{id}/findings`.
- **Lifecycle.** A new fingerprint opens an issue with prompt v1. A sighting marks it seen;
  a resolved issue that is seen again regresses. An open issue that is not seen resolves
  **only if** the check group its re-check names actually ran. A changed prompt body
  becomes a new prompt version. Dismissal needs a reason and is written to `audit_log`.
- **Prompt types.** Without a verified code trace, Pulse issues get `outage_triage`,
  `config_fix` or `investigate` (shown as "Unconfirmed lead"). `code_fix` needs a trace,
  which needs Scan and Link (Phases 3–4). Until then its template refuses to render.

## Consequences

- When Link lands, the `issues` step moves to `worker-link` and these packages are reused
  unchanged. Workers still never import each other.
- The fixture manifests' `promptType: code_fix` and `trace` expectations are Phase 4 gate
  items. The Phase 2 gate checks status, findings and that a prompt exists.
