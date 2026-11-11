# CodeSentra deployment guide

This is the canonical, production-grade deployment guide for self-hosting CodeSentra. It covers
the hardened image supply chain, the runtime isolation requirement, configuration, bring-up,
health verification, upgrades and rollback. The operational detail for each step lives in the
focused docs linked inline; this guide is the spine that orders them.

> CodeSentra is **deployment-ready**, not a hosted service. Nothing here deploys to the public
> internet or creates cloud resources for you — it builds signed, scannable artifacts and tells
> you how to run them on infrastructure you control.

## 1. Architecture at a glance

| Tier          | Services                                | Image                                        | Notes                                                                                  |
| ------------- | --------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Stateless app | `api`, `worker-link`, `web`             | `infra/node` (api, worker-link), `infra/web` | Horizontally scalable; share one Postgres + object store.                              |
| Pulse worker  | `worker-pulse`                          | `infra/pulse`                                | Drives a real Chromium (Playwright base).                                              |
| Scan worker   | `worker-scan`                           | `infra/scan`                                 | Runs **untrusted** project code; **must** use an isolating container runtime (see §3). |
| Backing       | Postgres 16, S3-compatible object store | —                                            | You operate these (managed services recommended).                                      |

Topology, per-service environment scoping and the scan VM are detailed in
[`docs/deployment.md`](deployment.md).

## 2. The hardened image supply chain

Every production image is built to the same bar, verified by the CI `images` job (build + smoke
test + Trivy scan) and the `release.yml` pipeline (SBOM + Sigstore signing + provenance):
- **Pinned by digest.** The base images are pinned to an immutable `@sha256:…` digest, not just a
  tag, so a rebuild can never silently pull a different base:
  - `node:22.23.4-bookworm-slim@sha256:5ec2…` for `infra/node`, `infra/web`, `infra/scan` and the
    `infra/pulse` build stage;
  - `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05…` for the Pulse runtime.
    To bump a base image, resolve the new digest (`docker buildx imagetools inspect <image>:<tag>`)
    and update the `ARG NODE_IMAGE` / `FROM` lines together with the tag.
- **Non-root.** Every image ends on an unprivileged user — `USER node` (api, worker-link, web,
  scan) or `USER pwuser` (pulse). The scan worker reaches the Docker socket through a
  supplementary group (`group_add`), never by running as root.
- **Healthchecked.** The HTTP services carry an image-level `HEALTHCHECK` using Node's built-in
  `fetch` (no extra tooling in the slim image):
  - **api** (`infra/node`) probes its own `/health` (process + DB + queue);
  - **web** (`infra/web`) probes the Next server on `:3000`.
    `worker-link` is built from the API's image but runs **no HTTP server**, so its compose service
    sets `healthcheck: { disable: true }`; its liveness is the process plus Docker's restart policy,
    and the API's `/ready` endpoint is what probes the queue it shares. The queue workers
    (`worker-pulse`, `worker-scan`) are likewise liveness-managed by the orchestrator's restart
    policy; readiness of the data plane is gated by the api/web healthchecks.
- **Scanned.** The `images` CI job fails the build on any fixable CRITICAL CVE (Trivy); HIGH ones
  are listed for review in [`docs/security.md`](security.md).

Build them:

```sh
docker build -f infra/node/Dockerfile --build-arg SERVICE=api         -t codesentra/api:<ver> .
docker build -f infra/node/Dockerfile --build-arg SERVICE=worker-link -t codesentra/worker-link:<ver> .
docker build -f infra/web/Dockerfile                                   -t codesentra/web:<ver> .
docker build -f infra/pulse/Dockerfile                                 -t codesentra/worker-pulse:<ver> .
docker build -f infra/scan/Dockerfile                                  -t codesentra/worker-scan:<ver> .
docker build -t codesentra/sandbox:<ver> infra/sandbox   # the untrusted-code runner (builds offline)
```

Cutting a signed release (tag → SBOM + cosign + npm provenance) is in [`docs/release.md`](release.md).

## 3. Runtime isolation (required for the scan worker)

`worker-scan` runs untrusted project code. In production it **must** use a container runtime that
gives each sandbox its own kernel or VM — **gVisor (`runsc`)**, Kata, or Firecracker. CodeSentra
refuses to start the scan worker with `SANDBOX_RUNTIME=runc` in production, and verifies the
runtime by running a throwaway container on every scan (a missing/ineffective runtime becomes an
honest coverage gap, never a false pass). Install and verify gVisor per
[`infra/sandbox/RUNTIME.md`](../infra/sandbox/RUNTIME.md). The positive `runsc` isolation path is
exercised in CI by the `runsc` job (sandbox safety suite + the "no code runs with the network"
isolation suite, under gVisor).

## 4. Configuration and secrets

Each service receives only the variables its role needs (`SERVICE_ENV` scoping): the API and Pulse
worker never get the Anthropic key; the scan worker never gets Slack. Start from
`.env.production.example`, keep secrets in your platform's secret store, and never bake them into
an image or commit them. The full variable list and per-service scoping are in
[`docs/deployment.md` §Configuration](deployment.md).

## 5. Bring up, migrate, verify

```sh
# 1. Apply migrations (idempotent; exits 0 when the schema is current).
docker run --rm $ENV --entrypoint node codesentra/api:<ver> \
  node_modules/@codesentra/db/dist/migrate-cli.js
# 2. Start the app tier and the scan VM (see docs/deployment.md for the compose/systemd units).
# 3. Verify health:
curl -fsS https://<api-host>/health | grep -q '"status":"ok"'   # liveness
curl -fsS https://<api-host>/ready                               # 200 when DB, queue and store are reachable
docker inspect --format '{{.State.Health.Status}}' <api-container>   # "healthy"
```

Migration safety (no unreviewed destructive DDL; RLS preserved) is enforced by the `db` migration
test in CI; backup/restore rehearsal is in [`docs/deployment.md` §Backups](deployment.md) and the
`scripts/backup-restore.sh` helper.

## 6. Upgrade and rollback

- **Upgrade:** build and push the new tag, run migrations (forward-compatible first), then roll the
  stateless services. Health/readiness gate each instance back into rotation.
- **Rollback:** retag the previous image digests and redeploy the stateless tier; **never roll the
  database back** — migrations are forward-only, so restore from backup only for data loss. The CLI
  is patched forward. Full procedure: [`docs/release.md` §Rollback](release.md).

## 7. Operate

SLOs and error budgets: [`docs/slos.md`](slos.md). Alerting rules:
`infra/observability/alerts.yml`. Incident response (including sandbox/queue/LLM/registry/storage
outages, where CodeSentra degrades to honest gaps rather than false results):
[`docs/incident-runbook.md`](incident-runbook.md).
