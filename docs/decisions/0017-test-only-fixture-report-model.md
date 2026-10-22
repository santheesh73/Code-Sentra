# 0017 — A scripted report model for tests only

- **Status:** accepted (Phase 3)

## Context

The Inventory and Explain stages call an LLM (Section 8). The Phase 3 gate must be
reproducible in CI. It must also include _forbidden claims_: fabrications the claim
verifier has to drop. A real model is neither deterministic nor guaranteed to fabricate,
and CI has no API key.

## Decision

- `ReportModel` is the only interface the pipeline uses. `anthropicModel` implements it
  with `client.messages.parse` and a Zod output format (one repair retry), handles refusal
  and `max_tokens`, and takes its model id from `ANTHROPIC_MODEL`.
- `fixtures/harness` exports `fixtureReportModel()`. For each fixture repo it returns
  scripted feature proposals and report drafts: the true claims, plus every forbidden
  claim from `expected.json`. It cites evidence by kind and locator, the same way a model
  must.
- worker-scan uses it only when `SCAN_TEST_MODEL=fixture`. `packages/config` refuses that
  value unless `NODE_ENV=test`, and the fixture package is imported dynamically, so
  production builds never load it.
- Without a model (and outside tests), Inventory and Explain are **gaps**. The report
  then has no prose, and features come only from the deterministic rules.

## Consequences

- The gate exercises the real verifier, classifier and health score against fabrications.
  It does not measure model quality, which needs a real key (an eval is future work).
- Feature _statuses_ never depend on the model. It proposes names and evidence, and
  `classifyFeatures` decides `complete`, `partial` or `planned` from evidence rules.
