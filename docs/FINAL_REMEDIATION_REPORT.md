# CodeSentra — Final Remediation Report

Remediation of the independent held-out re-audit (`audit/final/FINAL_AUDIT_REPORT.md`, commit
`b60c049` → re-verified at `02d7fdd`). This closes every finding that re-audit named, at root
cause, and converts every "could not verify here" condition into a CI-verified gate.

> **Scope of this report.** Every claim below is backed by merged code and a named CI job that
> runs on `main`. The scores in §4 are a **self-assessment** against the re-audit's own rubric and
> the findings now closed — they are **not** an independent re-audit. The fresh held-out re-audit
> (`CODESENTRA_FINAL_AUDIT.md`) and the spec-grading input (`docs/spec/CODESENTRA_KICKOFF.md`, F-07)
> were not attached, so the final independent sign-off remains pending on those two inputs; nothing
> else in the engineering program is blocked on them.

## 1. Verdict

**Every finding the held-out re-audit left open is closed at root cause, with a regression test and
a CI gate.** No Critical or High was open at the re-audit; the one reclassified Medium (N-4) and
the two Info findings (N-2, N-3) are closed structurally. The isolation, image, e2e, a11y and
compose gates the re-auditor could not run in their environment now run green in CI on every push.

## 2. Findings closed

| Finding                                                                     | Severity | Closure                                                                                                                                                                                                                                                                                                                                                                               | Proof                                                                  |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **N-4** (verifier keeps reworded check-outcome narrative)                   | Medium   | **Root-cause redesign**: the verifier now gates by _subject_ — it drops any model sentence whose subject is a check or the health score — and check outcomes are rendered from run data by versioned templates (`check-lines.ts`). The narrative channel cannot carry a check result by construction; the old polarity detector is kept only as a backstop. ADR 0037 supersedes 0031. | PR #19; `claims` unit + `corpus` suites; held-out probe sets drop 100% |
| **N-2** (false-corpus test cannot catch paraphrase drift)                   | Info     | **Property-based fuzz** generates check-subject sentences (subjects × outcome frames) and asserts all drop as `check_statement`, proving the gate is frame-independent — which a static corpus cannot. It immediately caught a real classifier gap (`package resolution`). The re-audit's held-out leak strings are folded into `corpus.json`.                                        | PR #20; `fuzz.test.ts`; false corpus 229 → 100% dropped                |
| **N-3** (sandbox image unbuildable offline — `rustup component add clippy`) | Info     | Non-slim `rust:…-bookworm` base ships clippy in the default profile, so the image builds with **no `static.rust-lang.org` egress**. Offline-verifiable regression + end-to-end CI (`cargo clippy` runs through the real image).                                                                                                                                                       | PR #21; `probe.test.ts`; `images` + `test` jobs                        |

## 3. Workstreams delivered

- **WS-A — Honesty, structurally** (PR #19). Subject gate (`subjects.ts`), templated check lines
  (`check-lines.ts`, versioned), new `check_statement` drop reason, web/CLI render checks from the
  one renderer, ADR 0037. Gate: `test`, `coverage`.
- **WS-B — Close remaining findings** (PR #20, #21). N-2 fuzz + corpus; N-3 offline image. Gate:
  `test`, `images`.
- **WS-D — "Can't verify here" → CI-verified** (PR #22, #23). A `Makefile` with a required `make`
  gate; a `runsc` job that installs gVisor, proves `verifyRuntime` reports **runsc + isolating**,
  and re-runs the full sandbox safety suite and the "no code runs with the network" isolation suite
  (npm/pnpm/yarn-classic/yarn-berry/pip/composer) **under gVisor**. The egress→offline install,
  PHP fixture and prod-refuses-runc guards already ran in `test`. Gate: `make`, `runsc`, `test`.
- **WS-C — Scorecard lifts** (PR #24, #25).
  - **Security ≥ 9**: the only thing holding it below 9 was "gVisor isolation CI-only"; the `runsc`
    job now proves the positive isolation path green in CI.
  - **Deployment ≥ 8**: production base images **digest-pinned** (manifest-list digests), **non-root**
    (unchanged), and **healthchecked** (api + web image `HEALTHCHECK`; worker-link's inherited one
    disabled with reason); `docs/DEPLOYMENT_GUIDE.md`. Gate: `images`, `compose`.
  - **UX ≥ 8**: the axe a11y gate, previously sign-in + projects only, now also gates the
    new-project and settings pages at desktop and 375 px. A latent fragility it exposed — the e2e
    suite was at the edge of the 20/15-min sign-in rate limit — is fixed with a configurable
    `AUTH_EMAIL_RATE_MAX` (production stays 20; the e2e stack gets headroom). Gate: `e2e`.
- **WS-E — Documentation honesty** (this PR). `docs/spec/TRACEABILITY.md` gains a **CI-gate column**
  and a guard test (`traceability.test.ts`, run in `test`) that fails CI if any requirement area is
  missing its code/tests/CI gate, cites a non-existent job, or if any CI job is untraced. This
  report; the README walkthrough stays green (`walkthrough`).

## 4. Scorecard (self-assessment vs. the re-audit's rubric)

| #           | Area                      | Re-audit |   Now    | Why it moved                                                                                |
| ----------- | ------------------------- | :------: | :------: | ------------------------------------------------------------------------------------------- |
| 1           | Product                   |    9     |    9     | —                                                                                           |
| 2           | Architecture              |    9     |    9     | —                                                                                           |
| 3           | Data & tenancy            |    9     |    9     | —                                                                                           |
| 4           | **Security**              |    8     |  **9**   | gVisor isolation now CI-proven (`runsc`); SSRF, tenancy, image scanning unchanged           |
| 5           | **Honesty & determinism** |    7     |  **9**   | Structural subject gate + data-rendered checks (ADR 0037); fuzz guard; held-out probes 100% |
| 6           | Testing                   |    8     |    9     | Fuzz, gVisor isolation, traceability guard; test count only rose                            |
| 7           | **UX & accessibility**    |    7     |  **8**   | axe gate broadened; runs green in CI                                                        |
| 8           | Ops                       |    8     |    8     | —                                                                                           |
| 9           | Performance               |    8     |    8     | —                                                                                           |
| 10          | **Deployment**            |    7     |  **8**   | digest-pinned non-root healthchecked images + deployment guide                              |
| **Overall** |                           | **8.0**  | **~8.6** | no open Critical/High/Medium; every gate CI-verified                                        |

Targets (every area ≥ 8, Security ≥ 9, overall ≥ 8.5, no Critical/High): **met on this
self-assessment.** Independent confirmation awaits the held-out re-audit.

## 5. Residual risks (honest)

- **Subject-classifier coverage.** The honesty guarantee now rests on recognising a check _subject_
  (a small, enumerable set) rather than success _wording_ (unbounded). A subject phrasing the
  classifier does not recognise would fall through to the ADR-0031 backstop; the fuzz guard and the
  development set grow from any miss. This is a strictly smaller residual than the old lexicon.
- **Measured held-out re-audit (self-run).** A fresh skeptical sweep of novel false check-outcome
  paraphrases — not in the corpus or fuzz — with all checks failing: a 20-string held-out set drops
  **100%**; a wider 39-string sweep drops **36/39**. The remaining 3 are pure success _metaphors_
  that name no check at all ("Nothing in the gauntlet tripped us up.", "Checks? All good.",
  "Style-wise we're squeaky clean."). That class is the open-NL residual ADR 0037 names: closing it
  would need an unbounded success lexicon (the treadmill N-4 penalised) or over-dropping legitimate
  prose. It is recorded and ratcheted in `packages/claims/src/reaudit.test.ts` (`KNOWN_RESIDUAL`),
  not claimed closed — this report does **not** assert "100% by any wording".
- **Second independent re-audit (H-1, closed).** A fresh third-party re-audit of merged `main`
  falsified the earlier framing that the _only_ residual was metaphors naming no check: the
  agent-noun subjects "the typechecker"/"type-checker" and "the packager"/"package manager" were
  plainly-named check subjects the classifier did **not** recognise, so e.g. "The typechecker
  passed." survived into narrative with typecheck failing — in both the subject gate and the
  ADR-0031 backstop. This is the "subject misclassification" residual ADR 0037 predicts (the subject
  set is the _closed_ part, so the fix is to extend the vocabulary, not to chase wording). Closed at
  root in `subjects.ts`/`outcome.ts`; regression cases added to `subjects.test.ts`, the fuzz
  `SUBJECT_PHRASES`, and `reaudit.test.ts` `CAUGHT` (fail-before/pass-after captured). The honesty
  guarantee holds for _named_ check subjects; the open residual remains the pure-metaphor class
  above, not a plainly-named subject.
- **CI-only by nature.** gVisor isolation, e2e/a11y, image/compose and signed-release gates require
  a gVisor- and egress-capable host; they are green in CI but cannot run in a Docker-less
  environment. Live GitHub App/OAuth, real Anthropic LLM and live OTel/Sentry export still need the
  owner's credentials.
- **Pending human inputs.** The fresh held-out re-audit script (`CODESENTRA_FINAL_AUDIT.md`) and the
  spec-grading input (`docs/spec/CODESENTRA_KICKOFF.md`, F-07) were not attached. Until F-07 lands,
  the traceability areas use the audit's Section 3.x ids, not the spec's exact requirement ids.

## 6. Reproduce

```sh
make check                 # lint + typecheck + build (no Docker)
pnpm test                  # unit + integration (Testcontainers; sandbox image)
# gVisor isolation path (needs a gVisor-capable host; CI job `runsc`):
#   see infra/sandbox/RUNTIME.md, then: REQUIRE_RUNSC=1 pnpm --filter @codesentra/sandbox test
```

Every claim here is gated by a job in `.github/workflows/ci.yml`; see
[`docs/spec/TRACEABILITY.md`](spec/TRACEABILITY.md) for the area → test → CI-gate map.
