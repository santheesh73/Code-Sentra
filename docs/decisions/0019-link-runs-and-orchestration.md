# 0019 — Link runs: parents of Scan and Pulse runs, started by a completion hook

- **Status:** accepted (Phase 4). Supersedes ADR 0015.

## Context

Section 5: a full check runs Scan and Pulse in parallel and then Link, "via a
job-completion hook". If one of them fails, Link still runs on what exists and records
the gap. Section 10d: on every later run of the same project or environment, Link
re-evaluates the issues. Until Phase 4, Pulse synced issues itself (ADR 0015). Scan
findings got prompts only on read (ADR 0018).

## Decision

- **Every project Scan and Pulse run feeds a Link run.**
  - `POST /v1/projects/{id}/pulse`, `/scan` and `/check`, and `/v1/issues/{id}/recheck`,
    all create a `link` run with steps `trace, widen, prompt, verify`. Its children are
    the scan, pulse or recheck runs, whose `parent_run_id` points to it.
  - The child runs are enqueued; the Link run is not.
  - Quick Pulse (no project) is unchanged: there is no Link run, and prompts are rendered
    on read.
- **Completion hook.**
  - When a run finishes in the worker runtime (normally, on its final failed attempt, or
    failed by the dead-job sweep), `startLinkIfReady` looks at its parent.
  - If the parent is a queued `link` run and every child is terminal, it enqueues
    `link.run`.
  - The job id is the run id, so siblings that finish together enqueue it once.
  - The API calls the same hook when it cannot enqueue a child (the child is failed with
    the reason).
- **Only Link writes issues.** Pulse no longer has an `issues` step. `link.run`
  (`packages/link/job`, run by `apps/worker-link`) does the following:
  - **trace:** traces every issue's leading finding against the code graph of the
    project's usable Scan. That is the check's own Scan child if it stored its results
    (a report row exists, even when a model stage failed), else the latest such Scan.
  - **widen:** computes the blast radius.
  - **prompt:** renders prompts. Verified traces get `code_fix`.
  - **verify:** runs `syncIssues` per child:
    - Pulse children per environment, with the groups that ran;
    - Scan children with `outcome.groups_ran`;
    - traces and the blast radius are stored.
- **Gaps.**
  - No usable Scan: `trace` and `widen` are skipped with the reason, and issues get
    `investigate` prompts.
  - A child that failed: its issues are not re-checked, and `verify` is skipped with
    "partly: …". The Link run is then `partial`, never green (Rule 2), and the log still
    says what was re-checked.
- **Targeted re-check.**
  - Pulse issues get a `recheck` run of just the issue's check group (`onlyGroups`).
    Reachability and platform always run first, because the other groups depend on them.
  - Environment badges read only `pulse` runs, so a re-check never changes one.
  - Scan issues get a new Scan of `repo_url`. Without one, the API answers 400 and says
    to upload a new zip.
- **The scan cache moves to `outcome.source_run_id`.** It no longer uses
  `parent_run_id`, which now always means the Link run.

## Consequences

- Issues appear when the Link run finishes, a moment after the Pulse or Scan run. Clients
  follow `link_run_id` (in the 202 of `/pulse` and `/scan`) or the child's
  `parent_run_id`.
- A Link run's stream carries only its own progress. Its page polls its children while
  they run.
- `worker-link` never fetches URLs or runs code. It reads stored evidence and code facts,
  and writes issues. No step needs the LLM yet: prompts are templates (Section 10c).
