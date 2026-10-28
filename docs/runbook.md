# Runbook

How to deploy and operate CodeSentra. **Nothing in this repository deploys by itself.**
`render.yaml` has `autoDeploy: false`, and there is no deploy job in CI. Every step below
is run by a person with access to the accounts.

## 1. What a person has to provide

| Item                                 | Used by                                    | Where it goes                                                        |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| Render account (or Fly)              | API, worker-link, worker-pulse, Postgres   | `render.yaml` Blueprint                                              |
| Vercel account                       | web                                        | `apps/web` project                                                   |
| A VM with Docker (Linux, x86_64)     | worker-scan                                | `infra/deploy/worker-scan.compose.yml`                               |
| S3-compatible bucket + keys          | snapshots, screenshots, direct zip uploads | `S3_*`, and `S3_PUBLIC_ENDPOINT` if browsers reach storage elsewhere |
| A container registry                 | the four images                            | pushed tags                                                          |
| GitHub App (section 4)               | PR checks, deployments                     | `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`                              |
| GitHub OAuth App (sign-in)           | "Sign in with GitHub"                      | `GITHUB_OAUTH_CLIENT_ID/SECRET`                                      |
| Resend account + verified domain     | sign-in links, alerts                      | `EMAIL_FROM`, `EMAIL_PROVIDER_API_KEY`                               |
| Slack app                            | Slack alerts                               | `SLACK_CLIENT_ID/SECRET`                                             |
| Anthropic API key                    | Scan reports                               | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`                               |
| Sentry DSN, OTLP endpoint (optional) | errors, traces                             | `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`                          |
| A domain                             | the app                                    | `PUBLIC_APP_URL`                                                     |

Generate the two local secrets once and keep them in the platform's secret store:
`SESSION_SECRET` (`openssl rand -hex 32`) and `ENCRYPTION_KEY` (`openssl rand -base64 32`).
Render can generate both (`generateValue`). **Every service must share the same
`ENCRYPTION_KEY`.** Losing it makes every sealed value unreadable: installations, bypass
tokens and notification channels.

## 2. Images

```sh
docker build -f infra/node/Dockerfile --build-arg SERVICE=api         -t $REG/codesentra-api:$TAG .
docker build -f infra/node/Dockerfile --build-arg SERVICE=worker-link -t $REG/codesentra-worker-link:$TAG .
docker build -f infra/pulse/Dockerfile                                 -t $REG/codesentra-worker-pulse:$TAG .
docker build -f infra/scan/Dockerfile                                  -t $REG/codesentra-worker-scan:$TAG .
docker build -t $REG/codesentra-sandbox:$TAG infra/sandbox
```

CI builds, smoke-tests and scans the first four on every push (`images` job). Render can
also build from the repository with `render.yaml`. It passes the `SERVICE` environment
variable to `infra/node/Dockerfile` as a build argument; check this on the first deploy.

## 3. First deploy

1. **Postgres (Render).**
   - Create the Blueprint from `render.yaml`. It creates `codesentra-db` and the three
     services, and does not deploy them.
   - Migrations create a `codesentra_app` role (NOLOGIN, no BYPASSRLS). If the database
     user cannot `CREATE ROLE`, run once as an admin:
     `CREATE ROLE codesentra_app NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT codesentra_app TO <db user>;`
2. **Secrets.** Fill every `sync: false` variable in the Render dashboard.
3. **API.** Deploy `codesentra-api` manually. The pre-deploy command applies migrations
   (they are idempotent). Then check `GET https://<api>/health` →
   `{"status":"ok","checks":{"database":"ok","queue":"ok"}}`.
4. **Workers.** Deploy `codesentra-worker-link` and `codesentra-worker-pulse`. In the logs,
   look for `worker-link ready` (it reports `email` and `scheduler_seconds`) and
   `worker-pulse ready`.
5. **Web (Vercel).**
   - Create a project with root directory `apps/web` (it uses `apps/web/vercel.json`).
   - Set `PUBLIC_APP_URL` (this domain) and `API_INTERNAL_URL` (the Render API URL).
   - Deploy, then sign in.
6. **worker-scan (VM)**, as in section 5.
7. Run a **full check** on a test project: upload a zip and add a deploy URL. The run
   view should show Scan, Pulse and then Link, with no unexpected gaps.

Every service refuses to start with a missing or placeholder secret (`packages/config`).
In production every integration it declares is required.

### Direct uploads

Zips go from the browser straight to the bucket under a presigned POST policy (key, type
and size pinned), so the web proxy's 4.5 MB limit does not apply. The bucket must allow
CORS `POST` from `PUBLIC_APP_URL`, for example:
`aws s3api put-bucket-cors --bucket <bucket> --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://app.example.com"],"AllowedMethods":["POST"],"AllowedHeaders":["*"]}]}'`.
MinIO allows cross-origin requests by default.

## 4. GitHub App

Create it at GitHub → Settings → Developer settings → GitHub Apps → New:
- **Permissions** (Section 16), and nothing else:
  - Contents: read
  - Checks: read & write
  - Pull requests: read
  - Deployments: read
  - Metadata: read
- **Events:** Installation, Installation repositories, Pull request, Deployment status, Push.
- **Webhook URL:** `https://<api host>/v1/webhooks/github`. Use the API's own URL, not the
  web proxy: Vercel caps request bodies at 4.5 MB and push payloads can be larger.
- **Webhook secret:** a random string (≥ 16 characters) → `GITHUB_WEBHOOK_SECRET`.
- **Setup URL:** `<PUBLIC_APP_URL>/api/v1/github/setup`. Tick "Request user authorization
  (OAuth) during installation" and "Redirect on update". Set the callback URL to the same
  address.
- Generate a private key (PEM) → `GITHUB_APP_PRIVATE_KEY`. Also copy the App ID, client
  id/secret and slug (`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_SLUG`).

Linking: an org admin opens **Settings → GitHub App → Install**. GitHub returns to the
setup URL, and CodeSentra links the installation only after GitHub confirms that the user
can access it. Then each project sets its repository under **Project settings**.

## 5. worker-scan VM

worker-scan runs untrusted code only inside the sandbox. It needs a Docker daemon with
gVisor, so it runs on its own VM.

```sh
# Docker Engine and gVisor (https://gvisor.dev/docs/user_guide/install/), then:
sudo runsc install && sudo systemctl restart docker
docker info --format '{{json .Runtimes}}' | grep runsc
sudo mkdir -p /var/lib/codesentra/scratch && sudo chown 1000:1000 /var/lib/codesentra/scratch
docker pull $REG/codesentra-sandbox:$TAG && docker pull zricethezav/gitleaks:v8.30.1
# /etc/codesentra/worker-scan.env: DATABASE_URL, ENCRYPTION_KEY, S3_*, GITHUB_APP_*,
# ANTHROPIC_*, WORKER_SCAN_IMAGE, SANDBOX_IMAGE, DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose --env-file /etc/codesentra/worker-scan.env -f infra/deploy/worker-scan.compose.yml up -d
```

With `SANDBOX_RUNTIME=runsc`, the worker refuses to scan if Docker has no runsc runtime. In
that case every probe becomes a gap: nothing is passed silently. The VM needs outbound
HTTPS to the database, the bucket, GitHub, the package registries (dependency fetch step)
and Anthropic. It needs no inbound ports.

## 6. Slack and email

- **Slack app:** enable "Incoming Webhooks". Add the redirect URL
  `<PUBLIC_APP_URL>/api/v1/slack/callback`, and copy the client id/secret.
- **Resend:** verify the sending domain, then set `EMAIL_FROM` (e.g.
  `CodeSentra <alerts@your-domain>`) and `EMAIL_PROVIDER_API_KEY`.

## 7. Phase 5 gate on real GitHub

The CI gate runs against a local fake of the GitHub API (`apps/api/src/__tests__/github.test.ts`).
The real run:
1. **Set up the repository.** Create a test repository from `fixtures/apps/env-undefined`
   without `.env.example`, and connect it to Vercel so pull requests get preview
   deployments. Leave `NEXT_PUBLIC_API_URL` unset for previews.
2. **Connect CodeSentra.** Install the GitHub App on that repository and link it. Create a
   project with `github_repo` set to the repository.
3. **Open a pull request** that adds the `fetch(\`${process.env.NEXT_PUBLIC_API_URL}/api/ping\`)`
   call.
   - Expect a **CodeSentra** check: `in_progress`, then completed.
   - After Vercel reports the preview deployment, the same check turns to **failure**. Its
     title reads "Degraded · … new issue(s)", and its text holds an `UNDEFINED_IN_URL` issue
     whose `code_fix` prompt names `NEXT_PUBLIC_API_URL` and `app/page.tsx:9`.
4. **Push the fix**: set the variable for previews and add `.env.example`. The new commit's
   check ends **success** ("Live · no new issues").
5. **Confirm nothing leaked.** The project's issue list is unchanged by the branch.

## 8. Operations

- **Health:** `GET /health` (database and queue). Every worker logs `… ready` at start.
- **Traces:** set `OTEL_EXPORTER_OTLP_ENDPOINT`. A request, its jobs and every step share
  one trace.
- **Errors:** set `SENTRY_DSN` to receive final job failures and API 5xx (scrubbed).
- **Stuck runs:** the worker sweep marks runs whose job died as failed, with the reason.
  The run view and `GET /v1/runs/{id}` show it.
- **Webhook failures:** GitHub → App → Advanced → Recent deliveries → Redeliver. A
  delivery that failed (e.g. 429) is processed on redelivery; a processed one never twice.
- **429s:** the run limits are in `apps/api/src/limits.ts` (`DEFAULT_RUN_LIMITS`). The
  response's `Retry-After` says when there is room again.
- **Schedules:** fired by worker-link every `SCHEDULER_INTERVAL_SECONDS`; 0 disables them.
  A schedule that keeps failing shows `last_error` in Project settings.
- **Rollback:** redeploy the previous image. Migrations are forward-only and additive; never
  roll back the database schema in place.
- **Backups:** use Render Postgres point-in-time recovery. The bucket holds snapshots and
  screenshots, both reproducible from their sources.
- **Secret rotation:**
  - `SESSION_SECRET`: signs out everyone.
  - `GITHUB_WEBHOOK_SECRET`: update GitHub and Render together.
  - API tokens: revoke in Settings.
  - `ENCRYPTION_KEY` (rotation, ADR 0024):
    1. Generate a new key (`openssl rand -base64 32`). On **every** service, set
       `ENCRYPTION_KEY` to the new key and `ENCRYPTION_KEY_PREVIOUS` to the old one, then
       deploy. New values are sealed with the new key, and old ones still open.
    2. Run `node node_modules/@codesentra/db/dist/reseal-cli.js` once, in the API image with
       the same environment. It rewrites every sealed column under the new key and prints a
       count per column. It exits 1, listing row ids, if any value cannot be opened; keep
       the key that sealed those values in `ENCRYPTION_KEY_PREVIOUS`. Running it again is
       harmless.
    3. Remove `ENCRYPTION_KEY_PREVIOUS` and deploy. Retire the old key.
