# GitHub App setup checklist

CodeSentra integrates with GitHub as a **GitHub App**: it posts a "CodeSentra" check run on
pull requests, checks preview deployments with Pulse, and re-scans on push. This is the
step-by-step to create and wire that App. The scripts referenced live in
[`scripts/github-app/`](../scripts/github-app/).

Deploying needs accounts and secrets only you can provide; this page covers only the GitHub
App. For the rest of the environment, see [`runbook.md`](runbook.md). Design rationale is in
[ADR 0021](decisions/0021-github-app-and-pr-checks.md).

## What the App is granted (least privilege)

The manifest requests only what the API uses:

| Permission | Access | Why |
|---|---|---|
| Contents | read | `worker-scan` clones the repo over HTTPS as the installation |
| Checks | write | post and update the "CodeSentra" check run on a PR |
| Pull requests | read | read PR head/base to scope a check |
| Deployments | read | read deployment status to Pulse-check preview URLs |
| Metadata | read | mandatory baseline |

Webhook events: `installation`, `installation_repositories`, `pull_request`,
`deployment_status`, `push`. The App is **private** (installable only where you choose).

## 1. Decide the public base URL

Pick the origin the API is reachable at, e.g. `https://app.example.com`. Every GitHub-facing
URL is derived from it and must resolve to the API:

- Webhook: `<base>/v1/webhooks/github`
- Setup / OAuth callback: `<base>/v1/github/setup`

For local development you may use `http://localhost:3000` with a tunnel (e.g. a reverse proxy)
for the webhook.

## 2. Generate the manifest

```sh
node scripts/github-app/setup.mjs manifest --base-url https://app.example.com --out codesentra-app.json
```

This prints the manifest and the next steps. It never contacts GitHub.

## 3. Create the App from the manifest

- [ ] Open the create page:
      - personal: `https://github.com/settings/apps/new`
      - org: `https://github.com/organizations/<ORG>/settings/apps/new`
- [ ] Use the **"Create GitHub App from a manifest"** flow and submit `codesentra-app.json`.
- [ ] After creation, note the **App slug** (the `github.com/apps/<slug>` name).

## 4. Collect the secrets

On the created App's settings page:

- [ ] **App ID** (numeric) → `GITHUB_APP_ID`
- [ ] **Generate a private key** (downloads a `.pem`) → `GITHUB_APP_PRIVATE_KEY`
      (paste the PEM; `\n`-escaped single-line form is accepted)
- [ ] **Client ID** → `GITHUB_APP_CLIENT_ID`
- [ ] **Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET`
- [ ] **Webhook secret** — set one on the App and use the same value for → `GITHUB_WEBHOOK_SECRET`
      (≥ 16 characters)
- [ ] **App slug** → `GITHUB_APP_SLUG`

Keep the private key, client secret and webhook secret out of version control; load them
through your secret manager (see `runbook.md`).

## 5. Verify the environment

```sh
node scripts/github-app/setup.mjs verify --env-file .env
```

Fix anything it reports before starting the API. It checks presence and shape (numeric App id,
PEM private key, secret lengths, slug form) against the same rules the server enforces in
`packages/config`.

## 6. Install and connect

- [ ] Start the API with the environment above.
- [ ] In CodeSentra, open **Settings → GitHub** for an org you administer and click **Install**
      (`GET /v1/github/install?org_id=…` redirects to GitHub).
- [ ] Approve the installation for the repositories you want checked. GitHub redirects back to
      `/v1/github/setup`, which verifies — via the user-authorization code — that you can access
      the installation and links it to your org. The raw `installation_id` is never trusted on
      its own.

## 7. Confirm end to end

- [ ] Open a pull request on an installed repository; a **CodeSentra** check run appears.
- [ ] Check the API logs for a received, signature-verified `pull_request` webhook.
- [ ] (Optional) trigger a preview deployment and confirm the `deployment_status` webhook runs
      a Pulse check into the same check run.

## Rotating secrets

Generating a new private key or client secret, or changing the webhook secret, is a config
change: update the environment, re-run `verify`, and restart the API. GitHub keeps old private
keys valid until you delete them, so rotate by adding the new key, deploying, then removing the
old one.
