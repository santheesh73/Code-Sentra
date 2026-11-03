# 0031 — Outcome-language verification in the claim verifier

- **Status:** accepted (remediation WS-2)

## Context

The audit (F-02) showed the claim verifier keeping reworded false claims. With every check
failed, it still kept "All tests are passing.", "The build is green.", "Lint passes.", "It is
fully tested and production-ready." and others — 12 of 15 tried. The cause was `CHECK_PATTERNS`,
a short list of exact phrases: a paraphrase outside the list was not recognised as an outcome
claim, so the "a skipped or failed check was not asserted as passed" rule never fired. The
verifier is the last guard against the report model fabricating success or being talked into it
by a crafted README, so this was the honesty guarantee failing.

The remediation prompt proposed the model emit a typed list of assertions per claim, checked
deterministically, plus an independent text guard.

## Decision

- **Enforcement is deterministic and derived from the claim text, not from the model.** A new
  module (`packages/claims/src/outcome.ts`) reads each sentence for the check-outcome it
  asserts (tests, build, typecheck, lint, install, dependency audit, secrets) and for
  unfalsifiable quality boasts. The verifier then requires:
  - a positive check claim ("the tests pass", in any of a wide set of phrasings) is kept only
    when that check actually passed; a skipped or failed check drops it (`outcome_unverified`);
  - a quality boast ("production-ready", "bug-free", "secure against …", "never crashes") is
    always dropped (`unverifiable_quality`): no check can establish it. **Default deny.**
- **It is not fooled by the model's own words.** We deliberately did _not_ take the
  "model emits typed assertions, schema rejects claims without them" route: a verifier that
  trusts the model to declare what it is asserting can be talked out of the declaration by the
  same prompt injection it is meant to withstand, and a missing-assertions rejection would
  blank a whole report on one malformed response. Deriving the assertions from the text is
  strictly stronger for the threat we care about, and leaves the model contract (and the
  pipeline) unchanged. This is the deviation from the proposed design.
- **Negation and partial results are respected.** A negation before or inside the phrase
  ("the build does not pass") makes it a negative claim, not a policed success claim. A
  mixed or counted result ("2 of 4 tests pass and 1 fails", "75% of tests pass") is honest
  reporting, not a blanket success claim, so it is not policed by this rule (a wrong number
  in it is still caught by the existing number check).
- **The technology list grew** so a report that names an infrastructure component or tool the
  evidence does not support (a data store, proxy, queue, bundler, language) is caught by the
  existing concrete-token rule, not silently kept (contributes to F-02).
- The existing rules — cited evidence must exist and belong to the run, concrete tokens and
  numbers must appear in it, feature-status claims must match the classifier — are unchanged.

## Consequences

- **The verifier drops 100% of a 211-claim adversarial corpus** (every wording of the audit's
  bypasses, quality boasts, fabricated technologies and numbers) and keeps ≥95% of a
  105-claim true corpus; both corpora live as data under `packages/claims/test-fixtures/`, and
  the drop/keep rates and determinism are asserted by `corpus.test.ts`. The audit's 15 exact
  strings are a unit test in `outcome.test.ts`.
- **The lexicon must be maintained.** New outcome phrasings or quality boasts, and new
  technology names, are added to `outcome.ts` and the token list; the corpus guards against
  regressions. A missed phrasing fails safe only if another rule catches it, so the corpus is
  grown whenever a gap is found.
- Two new drop reasons (`outcome_unverified`, `unverifiable_quality`) appear in the report UI.
