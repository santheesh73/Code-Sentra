# Security checklist (Section 17)

Each Section 17 item, where it is enforced, and the test that proves it. "CI" means the
test runs on every push and pull request (`.github/workflows/ci.yml`).

| #   | Item                                                                                                                                  | Enforced in                                                                                                                                                                                                                                                                                                      | Proven by                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Org isolation: RLS + query helpers, cross-org tests on every route                                                                    | `packages/db` `withOrg` (role `codesentra_app`, `app.org_id`), RLS migrations `0001`, `0003`, `0005`, `0008`, `0010`, `0012`; `apps/api/src/authz.ts`                                                                                                                                                            | `apps/api/src/__tests__/cross-org.test.ts` (every registered route is classified; every tenant route answers 404 to another org and 401 unauthenticated, and the victim's data is unchanged); `packages/db/src/*.test.ts` (RLS per table). CI                                                                                  |
| 2   | Required secrets validated at startup; no defaults like `change-me`                                                                   | `packages/config` (per-service schema, placeholder refusal, production requires every integration)                                                                                                                                                                                                               | `packages/config/src/index.test.ts` "refuses placeholder secrets", ".env.example documents exactly the variables the schema knows"; image smoke test (an unconfigured container exits). CI                                                                                                                                     |
| 3   | Secrets at rest encrypted (bypass tokens, GitHub installation data)                                                                   | `packages/core/src/crypto.ts` (AES-256-GCM, purpose as associated data, key id per value; rotation with `ENCRYPTION_KEY_PREVIOUS` and `reseal-cli`, ADR 0024): `environments.bypass_token_ref`, `github_installations.sealed`, `notification_channels.sealed`; API tokens and sessions are stored as sha256 only | `packages/core/src/crypto.test.ts`; `packages/db/src/reseal.test.ts` (rotation); `github.test.ts` (installation sealed); `automation.test.ts` (channels and bypass tokens sealed, token hash only). CI                                                                                                                         |
| 4   | SSRF tests: private IPs, DNS rebinding, redirect to metadata IP, IPv6, decimal/octal                                                  | `packages/ssrf` (global unicast only, DNS pinning, every redirect hop re-validated)                                                                                                                                                                                                                              | `packages/ssrf/src/ssrf.test.ts`: blocked ranges incl. `169.254.169.254`, CGNAT, ULA, IPv4-mapped/6to4/Teredo/NAT64; `http://2130706433/`, `0177.0.0.1`, `0x7f.0.0.1`, `017700000001`; "fails a host when any of its addresses is private (DNS rebinding)"; "re-validates every redirect hop: metadata, IPv4-mapped IPv6…". CI |
| 5   | Zip tests: bombs, traversal, symlinks, oversized, deeply nested                                                                       | `packages/scan/src/ingest`                                                                                                                                                                                                                                                                                       | `packages/scan/src/ingest/ingest.test.ts`: compression-ratio bomb, understated sizes, `../` and absolute paths, symlinks, NUL names, encrypted entries, duplicate/case-only paths, file count, depth and size limits. CI                                                                                                       |
| 6   | Sandbox: no network after install, no host mounts but the snapshot copy, non-root, read-only root, resource limits, killed on timeout | `packages/sandbox` (runsc preferred, runc + `--network none` + seccomp otherwise; ADR 0016)                                                                                                                                                                                                                      | `packages/sandbox/src/sandbox.test.ts`: no network or DNS, read-only root, unprivileged with no capabilities, no worker env, timeout kill, output cap, memory and process limits. CI (runc; gVisor in production, see runbook)                                                                                                 |
| 7   | Secrets never stored in evidence or sent to the LLM                                                                                   | `packages/scan/src/secrets.ts` (gitleaks `--redact`, masking again before storage); the report bundle is built from stored evidence only                                                                                                                                                                         | `packages/scan/src/gate.test.ts` "never stores a secret value": not in evidence, findings, verified claims, **or any input sent to the report model**; `automation.test.ts`: a bypass token is not in evidence or findings. CI                                                                                                 |
| 8   | Rate limits: per org, per user, per target host, per run type; Quick Pulse per IP                                                     | `apps/api/src/limits.ts` (counted from `runs`, so exact across replicas; 429 + `Retry-After`); `@fastify/rate-limit` per IP on Quick Pulse, sign-in, check and token routes; schedules ≥ 5 min; `packages/ssrf` `HostLimiter` per target host inside a run                                                       | `automation.test.ts` "run limits": per-type limit and cross-org per-host limit answer 429. CI                                                                                                                                                                                                                                  |
| 9   | Audit log: membership, project deletion, dismissals, token creation                                                                   | `audit_log` (append-only for the app role); `GET /v1/orgs/{id}/audit` for admins                                                                                                                                                                                                                                 | `api.test.ts` (membership, project deletion), `pulse.test.ts` "dismisses with a reason, audited", `automation.test.ts` (token creation and revocation, schedules, notification channels). Also: GitHub installation linking, bypass token set/removed. CI                                                                      |
| 10  | Dependency and container image scanning in CI                                                                                         | `deps` job: `pnpm audit --prod --audit-level=high`; `images` job: Trivy (pinned by digest) on all four production images; `secrets` job: gitleaks on the full history                                                                                                                                            | CI jobs `deps`, `images`, `secrets`                                                                                                                                                                                                                                                                                            |

## Accepted exceptions

- **GHSA-86w9-cpqp-85rv (node-forge, high).** Only `fixtures/harness` (test-only, never
  deployed) uses node-forge, and only to _generate_ test certificates; the advisory is in
  signature _verification_. No patched version exists. Recorded in `pnpm-workspace.yaml`.
- **Container images:** HIGH vulnerabilities with a fix are listed by the `images` job for
  review; CRITICAL ones with a fix fail it. Unfixed vulnerabilities are not actionable and
  are not shown.

## Other protections added in Phase 5

- **GitHub webhooks.** The signature (`X-Hub-Signature-256`) is checked over the exact
  bytes received, in constant time, before anything else. Deliveries are processed once,
  by delivery id; only a failed one can be redelivered. A webhook acts only on projects of
  the org that linked the installation.
- **Installation linking.** GitHub's `installation_id` is never trusted. It is linked only
  if the signed state names the current user and an org they administer, and the user's
  OAuth code proves through GitHub that they can access the installation.
- **API tokens.** Each token is bound to one org. Creating one needs a session, never
  another token. Bearer requests carry no ambient credential, so they need no CSRF check.
- **Alerts.** Email goes only to org members. Slack is added only through OAuth. Its
  webhook URL must be on `hooks.slack.com` when stored and again before each post, and
  redirects are refused.
- **Observability.** Sentry events never carry request bodies, cookies, `authorization`
  or webhook signatures (`packages/telemetry` `scrubEvent`, tested). Logs redact cookies
  and `authorization`.

## Added in Phase 6 (ADR 0024)

- **Direct uploads.** The presigned policy pins the object key,
  `Content-Type: application/zip` and the size range. The object is checked (size, zip
  magic bytes) before the snapshot can be scanned, and deleted if rejected. Extraction
  limits apply as before. Tested in `uploads.test.ts` and `packages/storage/src/upload.test.ts`
  (real MinIO refuses an oversized or mistyped upload).
- **GitHub clones.** The installation token reaches git only through `GIT_CONFIG_*`
  environment variables (never argv or the remote URL), and the clone keeps the SSRF pin.
  Tested in `packages/scan/src/ingest/github-clone.test.ts`.
- **Org deletion.** Owner and session only, with the slug as confirmation. It removes
  every tenant row and the org's storage prefixes. `org-lifecycle.test.ts` checks that
  every tenant table is empty for that org; `cross-org.test.ts` attacks the route.

## Added in Phase 8 (ADR 0026)

- **The Go dependency download** runs `go mod download`, which executes no code. It
  fetches from `GOPROXY=https://proxy.golang.org` only, with no `direct` fallback, so a
  `go.mod` cannot send the fetch to a VCS host. Every module is checked against
  `sum.golang.org`, and `GOTOOLCHAIN=local` stops a toolchain download. The remaining steps
  run with `GOPROXY=off` and no network. Tested in `probe.test.ts` ("Go: module-proxy-only
  download …").
- **Ruby and JVM projects** were not built in Phase 8. Phase 9 builds Ruby and Maven
  projects without running code during the download. Gradle is still a gap.
- **Manifests are read as text.** `Gemfile`, `build.gradle` and `pom.xml` are parsed with
  patterns and never evaluated.

## Added in Phase 9 (ADR 0027)

- **Ruby downloads read the lockfile, never the Gemfile.**
  - The download step is CodeSentra's own script, run with `python -I`.
  - It fetches only the exact `.gem` files `Gemfile.lock` pins, from rubygems.org over
    HTTPS, and follows redirects only to `*.rubygems.org`.
  - Each file is checked against the lockfile's sha256 where it has one.
  - Git sources, other gem servers and odd names are refused.
  - Tested in `probe.test.ts` ("Ruby: …").
- **Maven downloads run only Maven's pinned dependency plugin.**
  - Every repository is mirrored to Maven Central, and checksums are enforced.
  - `.mvn/` is set aside, and POMs or `.mvn/extensions.xml` declaring extensions are
    refused.
  - Residual risk: a parent POM fetched from Central could still declare extensions
    (ADR 0027).
  - Tested in `probe.test.ts` ("Maven: …").
