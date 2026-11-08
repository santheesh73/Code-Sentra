# Deployment (self-hosted)

This is the deployment-ready path for running CodeSentra on **your own hosts** with Docker
Compose and pushed images. For the managed path (Render + Vercel) see
[`runbook.md`](runbook.md); the GitHub App is covered in
[`github-app-setup.md`](github-app-setup.md). Nothing here deploys anything — it documents the
commands and configs an operator runs by hand.

## Topology

| Tier | Runs                                                    | Config                                                                            |
| ---- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| App  | API, worker-pulse, worker-link, web, migrate (one-shot) | [`infra/deploy/app.compose.yml`](../infra/deploy/app.compose.yml)                 |
| Scan | worker-scan on a dedicated gVisor VM                    | [`infra/deploy/worker-scan.compose.yml`](../infra/deploy/worker-scan.compose.yml) |
| Data | Postgres 16, S3-compatible object storage               | managed services you provide                                                      |

Why worker-scan is separate: it runs untrusted project code, so it only ever runs inside the
sandbox on an isolated VM with the gVisor (`runsc`) runtime. Nothing else runs on that VM.
The app tier is stateless and horizontally scalable (the queue hands each job to one replica
— see `packages/queue`), so you can run several copies of each worker.

## Images

Build and push the five images to your registry (`$REG`, `$TAG`):

```sh
docker build -f infra/node/Dockerfile --build-arg SERVICE=api         -t $REG/codesentra-api:$TAG .
docker build -f infra/node/Dockerfile --build-arg SERVICE=worker-link -t $REG/codesentra-worker-link:$TAG .
docker build -f infra/pulse/Dockerfile                                 -t $REG/codesentra-worker-pulse:$TAG .
docker build -f infra/scan/Dockerfile                                  -t $REG/codesentra-worker-scan:$TAG .
docker build -t $REG/codesentra-sandbox:$TAG infra/sandbox
docker build -f infra/web/Dockerfile                                   -t $REG/codesentra-web:$TAG .
docker push $REG/codesentra-{api,worker-link,worker-pulse,worker-scan,sandbox,web}:$TAG
```

CI builds, smoke-tests and Trivy-scans the service images on every push (`images` job). The
images run as a non-root user and carry only the deployed service's production dependencies.

## Configuration

Render [`.env.production.example`](../.env.production.example) through your secret manager into
an env file (e.g. `/etc/codesentra/app.env`). Each service receives **only** the variables it
needs (`packages/config` `SERVICE_ENV`): the API and Pulse worker never see the Anthropic key;
the scan worker never sees Slack. Every integration a service declares is required in
production — a missing or placeholder value makes it refuse to start.

Generate the secrets once:
- `ENCRYPTION_KEY` — 32 bytes base64 (`openssl rand -base64 32`). Rotating it later: set the
  new key and move the old to `ENCRYPTION_KEY_PREVIOUS` (ADR 0025).
- `SESSION_SECRET` — ≥ 32 random chars.
- GitHub App secrets — via [`github-app-setup.md`](github-app-setup.md); validate with
  `node scripts/github-app/setup.mjs verify --env-file /etc/codesentra/app.env`.

Point `DATABASE_URL` at the app role, which must **not** bypass RLS. If your admin user cannot
`CREATE ROLE`, create it once:

```sql
CREATE ROLE codesentra_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT codesentra_app TO <db_admin>;
```

## Bring up the app tier

```sh
cd infra/deploy
E=/etc/codesentra/app.env

# 1. Migrate (idempotent; exits 0 when the schema is current).
docker compose --env-file $E -f app.compose.yml run --rm migrate

# 2. Start API, workers and web.
docker compose --env-file $E -f app.compose.yml up -d

# 3. Health.
curl -fsS https://<api-host>/health     # {"status":"ok","checks":{"database":"ok","queue":"ok"}}
docker compose --env-file $E -f app.compose.yml ps   # api + web show healthy
```

The compose publishes the API and web to `127.0.0.1` by default (`API_PUBLISH`, `WEB_PUBLISH`);
put your own TLS-terminating reverse proxy in front. The GitHub webhook must reach the **API**
directly (`https://<api-host>/v1/webhooks/github`), not the web proxy, because push payloads
can exceed a typical proxy body limit.

Object storage needs CORS for direct browser uploads (ADR 0024): allow `POST` from
`PUBLIC_APP_URL`.

## Bring up the scan VM

On a separate VM with Docker + gVisor installed (https://gvisor.dev/docs/user_guide/install/):

```sh
# /etc/codesentra/worker-scan.env: DATABASE_URL, ENCRYPTION_KEY, S3_*, GITHUB_APP_*,
# ANTHROPIC_*, WORKER_SCAN_IMAGE, SANDBOX_IMAGE, DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose --env-file /etc/codesentra/worker-scan.env -f worker-scan.compose.yml up -d
```

See [`runbook.md`](runbook.md) §5 and [`../infra/sandbox/RUNTIME.md`](../infra/sandbox/RUNTIME.md)
for the runtime requirements (the worker refuses `runc` in production).

## Deploying a new version

1. Build and push the images at the new `$TAG`; update the `*_IMAGE` values in the env file.
2. `run --rm migrate` (migrations are backward-compatible; apply before the new code).
3. `up -d` to roll the app tier; update the scan VM separately.
4. Re-check `/health` and watch the worker logs for `worker-link ready` / `worker-pulse ready`.

To roll back, point the `*_IMAGE` tags at the previous build and `up -d` again; migrations are
additive, so the older code runs against the newer schema.

## Verify end to end

Run a full check on a test project (upload a zip, add a deploy URL). The run view should show
Scan, Pulse, then Link, with no unexpected gaps. Open a PR on an installed repository and
confirm the CodeSentra check run appears.
