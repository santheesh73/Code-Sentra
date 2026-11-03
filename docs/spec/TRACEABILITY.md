# Requirement traceability

Each requirement area (from the audit's Section 3.1–3.17 enumeration; exact IDs to be filled
once `CODESENTRA_KICKOFF.md` is committed, F-07) maps to the implementing code and the tests
that cover it. Remediation of audit findings is cross-referenced to its ADR.

| Area                                           | Implemented in                                                        | Tests                                                                             | Notes / ADR                                       |
| ---------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| 3.1 Monorepo, strict TS, Biome                 | root config, `turbo.json`, `biome.json`, `tsconfig.*`                 | `pnpm lint`, `pnpm typecheck`                                                     | TS 7/6 split: ADR 0001, 0034                      |
| 3.2 Config, fail-fast, no placeholder secrets  | `packages/config/src/index.ts`                                        | `packages/config/src/index.test.ts`                                               | `.env.example` drift test                         |
| 3.3 Data model + RLS                           | `packages/db` (migrations, `client.ts`)                               | `packages/db/src/db.test.ts`                                                      | ADR 0009                                          |
| 3.4 Auth, sessions, CSRF, rate limits          | `apps/api/src/auth`, `session-plugin.ts`, `app.ts`                    | `apps/api/src/*.test.ts`                                                          |                                                   |
| 3.5 Queue + workers                            | `packages/queue`, `apps/worker-*`                                     | `packages/queue` tests; replica test (Section 3)                                  |                                                   |
| 3.6 Pulse checks                               | `packages/checks`                                                     | `packages/checks/src/pulse.test.ts`                                               | favicon info: ADR, F-12                           |
| 3.7 Scan: ingest, probes, audit, secrets       | `packages/scan`                                                       | `packages/scan/src/**/*.test.ts`                                                  | download isolation: ADR 0030; zip names: ADR 0033 |
| 3.8 Link: trace, blast radius, prompts         | `packages/link`                                                       | `packages/link/src/*.test.ts`                                                     |                                                   |
| 3.9 Security: SSRF, sandbox, tenancy, webhooks | `packages/ssrf`, `packages/sandbox`, `packages/db`, `packages/github` | ssrf/sandbox/db/github tests, `probe/isolation.test.ts`, `sandbox/egress.test.ts` | ADR 0030, 0032; runtime isolation                 |
| 3.10 Honesty: evidence-backed claims           | `packages/claims`                                                     | `claims.test.ts`, `corpus.test.ts`, `outcome.test.ts`                             | ADR 0031, F-02/F-10                               |
| 3.11 API: OpenAPI, RFC 9457, SSE               | `apps/api`                                                            | api tests, OpenAPI drift (CI)                                                     |                                                   |
| 3.12 Web UI + responsive + a11y                | `apps/web`                                                            | `e2e/tests/*` incl. `a11y.spec.ts`                                                | F-11                                              |
| 3.13 CLI: commands, exit codes                 | `apps/cli`                                                            | `apps/cli/src/*.test.ts`                                                          | F-17                                              |
| 3.14 GitHub integration                        | `packages/github`, `apps/api/src/routes/github.ts`                    | fake-GitHub tests                                                                 | live: needs credentials                           |
| 3.15 Observability (OTel, Sentry)              | `packages/telemetry`                                                  | telemetry tests; trace integration (Section 3)                                    |                                                   |
| 3.16 CI, deploy, images                        | `.github/workflows/ci.yml`, `infra/*`                                 | CI                                                                                | SHA pins + Renovate: F-06                         |
| 3.17 Docs, ADRs, progress                      | `docs/`                                                               | —                                                                                 | spec file pending (F-07)                          |

## Keeping it honest

When `CODESENTRA_KICKOFF.md` is committed, replace the area descriptions with the spec's exact
requirement IDs, and add a CI check that every requirement ID appears at least once in this
table — so a requirement cannot be dropped silently.
