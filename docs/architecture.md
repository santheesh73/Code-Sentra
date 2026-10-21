# CodeSentra architecture

The kickoff document (Sections 1–20) is the source of truth. This file records what
exists in the repository right now and how the pieces fit together.

## Current state: Phase 0 (fixtures and skeleton)

```
codesentra/
  packages/
    core/       finding codes and declarations, evidence/report/claim schemas, enums,
                fingerprints, Pulse status rule, issue re-check lifecycle
    config/     per-service env validation (fails fast, rejects placeholders)
  fixtures/
    apps/       6 Next.js static-export apps, each with a fixture.json
    harness/    serves the apps + failure simulators; Chromium self-test
    repos/      ts-taskboard, py-notes-api (scan input in repo/, expected.json beside it)
  infra/
    docker-compose.yml   postgres 16, minio (+ bucket init), fixture harness (profile)
  docs/
    decisions/  ADRs 0001–0006
```

Not built yet: `apps/*`, `packages/{db,queue,graph,parsers,checks,claims,prompts,sandbox,ssrf}`,
and `infra/{sandbox,pulse}`. They arrive in the phases listed in Section 18.

## Contracts already fixed

- **Finding codes** (`@codesentra/core`): `SCAN_CODES`, `PULSE_CODES`, and
  `FINDING_CODE_DECLARATIONS` (module, default severity, prompt type, trace requirement,
  merge specificity, re-check descriptor). Codes are the stable contract; titles may change.
- **Evidence**: `EvidenceKind`, `EvidenceInput { kind, locator, payload }`, and
  `evidenceHash = sha256(kind \n locator \n canonicalJson(payload))`.
- **Fingerprint**: `sha256(code \n normalizeLocator(module, locator) [\n normalizedMessage])`,
  in `@codesentra/core/hashing`.
- **Status rule**: `computePulseStatus({ main, groups, findings })` returns `{ status, gaps }`.
- **Lifecycle**: `nextIssueStatus(current, { checkGroupRan, observed })`.
- **LLM output schemas**: `ReportDraftSchema` and `FeatureProposalSchema`. Every claim is
  `{ text, evidence_ids[] }`.

## Fixture harness

`startHarness()` binds 127.0.0.1 ephemeral ports, or sequential ports from `HARNESS_BASE_PORT`.
It returns `targets.apps[name].url`, `targets.simulators[name].url`, the throwaway CA PEM,
and `setVariant(app, variant)`. `pnpm fixtures:serve` prints the targets as JSON. In
compose, the harness listens on `localhost:4100+`.

## Local development

```sh
pnpm install
cp .env.example .env   # fill in values; POSTGRES_PASSWORD and S3_* are enough for infra
pnpm infra:up          # postgres + minio
pnpm build && pnpm test
pnpm fixtures:serve    # or: pnpm infra:fixtures (containerised)
```

Behind a TLS-intercepting proxy, build the harness image with
`docker build --secret id=extra_ca,src=<ca.pem> -f fixtures/harness/Dockerfile -t codesentra-fixture-harness .`
