# Changelog

All notable changes to CodeSentra are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). See
[`docs/release.md`](docs/release.md) for how a release is cut.

## [Unreleased]

### Added

- Production readiness (Section 20): `/ready` dependency probe; queue dead-letter visibility
  (`GET /v1/orgs/:id/dead-letters`) and hardened, time-bounded graceful shutdown; per-org LLM
  monthly cost cap; DB migration-safety CI gate and `scripts/backup-restore.sh`; a release
  workflow that SBOMs, scans and signs images and publishes the CLI with provenance; data
  retention sweep, per-org JSON export and documented deletion; SLOs, Prometheus alerting rules
  and an incident runbook.
- Section 3 hardening: per-package coverage thresholds in CI; a multi-replica worker test; a
  README-walkthrough CI job; an OpenTelemetry collector integration test; performance budgets;
  recorded LLM contract tests with a gated live suite; GitHub App setup tooling; a self-hosted
  app-tier compose and deployment guide.

## [0.1.0] — unreleased

First tagged release once the above stabilises. Baseline: Sentra Scan, Pulse and Link across
TypeScript, JavaScript, Python, Go, Ruby, Java, Rust and PHP; evidence-first reports with a
deterministic claim verifier; GitHub App check runs; schedules and alerts; the CLI; and the
full remediation of the first external audit (findings F-01…F-18).

[Unreleased]: https://github.com/santheesh73/Code-Sentra/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/santheesh73/Code-Sentra/releases/tag/v0.1.0
