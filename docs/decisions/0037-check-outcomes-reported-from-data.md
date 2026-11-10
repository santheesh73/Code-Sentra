# 0037 — Check outcomes are reported from data, not policed in narrative

- **Status:** accepted (final remediation WS-A)
- **Supersedes:** [0031 — Outcome-language verification in the claim verifier](0031-outcome-language-verification.md)

## Context

ADR 0031 made the claim verifier read each model sentence for the check-outcome it asserts and
drop a positive outcome claim ("the tests pass") unless that check actually passed. It closed the
audit's F-02 bypasses and held a 211-claim adversarial corpus at 100% dropped. But it rested on a
lexicon — a set of phrasings the detector recognises as an outcome claim — and ADR 0031 itself
recorded the residual risk: _"The lexicon must be maintained. A missed phrasing fails safe only if
another rule catches it."_

The held-out re-audit (finding **N-4**) exercised exactly that residual risk. It did not attack the
lexicon head-on; it found paraphrases whose _surface_ carried no policed outcome word yet whose
_meaning_ was "the checks passed" — "The build compiles cleanly.", "The suite of tests is passing.",
"There are no CVEs in the dependency tree.", "No lint warnings remain." Each slipped past the
positive-outcome patterns and was kept. A follow-up detector (PR #18) widened the patterns and
caught that round. But widening the patterns is the same move that N-4 had just defeated: it makes
the next unseen paraphrase the bypass.

### Why vocabulary detection cannot be complete

The verifier's job is an **open-class natural-language judgement**: decide whether an arbitrary
sentence asserts that a check succeeded. Natural language has unbounded ways to assert any
proposition — lexical ("green", "clean", "passing", "succeeds"), figurative ("the build is
healthy"), implicational ("ready to ship", which presupposes the checks passed), and
negation-of-negation ("no failures remain"). A detector is a finite recogniser over that infinite
set, so for any detector there exists a sentence it does not recognise that nonetheless asserts
success. Each audit round that adds the latest miss to the lexicon is, by the remediation prompt's
own definition, a **symptom patch**: _"If a fix works by adding words or cases to make a known
failing input pass, it is a symptom patch. Stop and redesign."_ The threat model is an adversary
(a crafted README, or a model talked into spin) who will always have one more paraphrase. A guard
that must enumerate wordings is structurally behind that adversary.

## Decision

Stop trying to tell true outcome-narrative from false outcome-narrative. **Remove check outcomes
from the narrative channel entirely, and report them from run data.** Two structural changes make
"the narrative cannot state a check result" true by construction rather than by recognition:
1. **The verifier gates by _subject_, not by _polarity_** (`packages/claims/src/subjects.ts`).
   `checkSubject(text)` returns the check a sentence is _about_ — tests, build, typecheck, lint,
   install, dependency audit, secrets, or the health score — from the subject the sentence takes,
   regardless of what it predicates of it. `verifyClaim` drops **any** sentence with a check
   subject, with reason `check_statement`, before polarity is ever considered. "All tests pass.",
   "2 of 4 tests pass.", "No tests were run.", "The suite is green." — pass, fail, count, or clean,
   every one is dropped from narrative. There is nothing for a paraphrase to evade: it does not
   matter _what_ the sentence says about the check, only _that_ its subject is a check. The decision
   no longer depends on recognising an outcome word.

2. **Check outcomes are rendered from stored data by deterministic, versioned templates**
   (`packages/claims/src/check-lines.ts`, `CHECK_LINES_VERSION`). One line per check is produced
   from the run's recorded outcome and counts — pass, fail (with counts), partial (mixed counts),
   skipped-as-gap, and not-applicable all covered — in fixed language the model never writes and
   cannot soften. Same input → byte-identical output. This is the _only_ place a check outcome
   appears in a report. The web, CLI and GitHub surfaces already read check status from the
   `checks` data field (separate from `claims`), never from narrative; this ADR makes those lines
   go through the one templated renderer so the wording is versioned and uniform.

   So the honesty guarantee is now the composition of two structural facts: the narrative channel
   _cannot carry_ a check outcome (subject gate), and the data channel _states it in fixed
   language_ (templates). Neither depends on a lexicon of success phrasings.

3. **The ADR 0031 outcome/polarity detector is kept as a defence-in-depth backstop, not the
   guarantee.** `outcome.ts` still runs _after_ the subject gate. In normal operation the subject
   gate has already dropped every check sentence, so the backstop fires on nothing; it exists only
   to catch a check-outcome assertion that somehow reached the narrative with a subject the gate
   failed to classify. It is a second line, explicitly not the thing the guarantee rests on.

4. **Unfalsifiable quality boasts are still always dropped** ("production-ready", "bug-free",
   "secure against …") with reason `unverifiable_quality` — unchanged from ADR 0031. No check can
   establish them, and they have no data channel, so they are simply refused.

5. **What the model still writes, and the verifier still keeps:** what the project is, why it is
   useful, the feature→code mapping with its evidence-computed status, and issue context. Those are
   evidence-backed narrative, not check outcomes, and the existing rules (cited evidence must exist
   and belong to the run; concrete tokens and numbers must appear in it; feature-status claims must
   match the classifier) are unchanged.

## Consequences

- **The guarantee is structural.** "A model sentence cannot state a check result" is now a property
  of the subject gate, not of how many phrasings the lexicon has seen. The adversarial false
  corpora still drop 100% (claims unit suite, `corpus.test.ts`, and the three held-out probe sets:
  44/44, 16/16, 23/23 kept-zero). True _check-subject_ sentences now also drop from narrative — by
  design: they are reported from data instead. Retention is therefore measured on the **non-check**
  true corpus only (`corpus.test.ts` keeps ≥95% of it); `isCheckStatement` partitions the corpus.
- **New drop reason `check_statement`** joins the report schema (`@codesentra/core`) and the web
  drop-reason legend. It reads "stated a check result, which is reported from data, not narrative".
  `outcome_unverified` and `unverifiable_quality` remain for the backstop and quality boasts.
- **Templated check lines are versioned.** `CHECK_LINES_VERSION` is bumped deliberately when the
  wording changes, so a stored report records which template produced its lines. `check-lines.test.ts`
  pins every check × every state and asserts determinism.
- **What still needs maintaining, and what no longer does.** The _lexicon of outcome phrasings_ no
  longer has to be complete — that burden is gone. What remains is the **subject classifier**: it
  must map a sentence's subject to the right check. This is a strictly smaller and more tractable
  problem than recognising every way to assert success, because a check has a small, stable set of
  names (tests/specs/suite/coverage, build/compile, typecheck, lint, install, audit/CVEs/
  vulnerabilities, secrets) whereas success has unbounded predicates. `subjects.test.ts` is the
  development set guarding the classifier; new subject phrasings found in future audits are added
  there, kept separate from any held-out set.

## Residual risks

- **Subject misclassification.** If a sentence's subject is a check but `checkSubject` does not
  recognise it, the subject gate does not fire and the sentence falls through to the ADR 0031
  backstop. If the backstop also misses it, a check-outcome sentence could be kept. This is the one
  remaining lexicon-shaped risk, but it is over _subjects_ (a small, stable vocabulary), not over
  _success predicates_ (unbounded), and two independent guards must both miss. New misses are added
  to the subject classifier's development set.
- **Implication and presupposition.** A sentence with a non-check subject that _presupposes_ a check
  passed ("the service is ready to deploy") carries an outcome implicitly. The subject gate does not
  fire (subject is "the service", not a check); `unverifiable_quality` catches the readiness class,
  but novel implication framings are a known gap, mitigated by the quality-boast rule and grown from
  audit findings.
- **Data-channel correctness.** Moving outcomes to data makes the guarantee only as honest as the
  recorded outcomes. That is the intended trust boundary: outcomes come from the sandbox probes and
  deterministic collectors (evidence-first), never from the model, and `skipped` is never recorded
  as `pass`. The templates render whatever the data says, faithfully, including gaps.
