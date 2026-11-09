# Release process

How CodeSentra is versioned, released and rolled back. The automation is in
[`../.github/workflows/release.yml`](../.github/workflows/release.yml); deployment is in
[`deployment.md`](deployment.md).

## Versioning (SemVer)

The product is versioned with [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
- **MAJOR** — a breaking change to a public contract: the HTTP API, the CLI flags/exit codes,
  the webhook payloads, or the database migration path.
- **MINOR** — backward-compatible features (a new check, language, endpoint or CLI command).
- **PATCH** — backward-compatible fixes.

The images and the CLI share one version — the git tag. Pre-releases use `-rc.N`.

## Changelog

Every user-visible change lands with an entry under **Unreleased** in
[`../CHANGELOG.md`](../CHANGELOG.md) (Keep a Changelog: Added / Changed / Fixed / Removed /
Security). Cutting a release moves those entries under the new version with the date.

## Cutting a release

1. Ensure `main` is green (all CI jobs) and the migration-safety gate passes.
2. Move the **Unreleased** changelog entries under the new `MAJOR.MINOR.PATCH` with today's date
   and update the compare links.
3. Tag and push:

   ```sh
   git tag -s v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```
4. The release workflow runs on the tag and, for each image (api, worker-link, worker-scan,
   worker-pulse, sandbox):
   - builds it, generates a **CycloneDX SBOM** (Trivy) and uploads it as an artifact;
   - **scans** it (Trivy) and fails on any fixable CRITICAL;
   - pushes it to GHCR;
   - **signs** the image and **attests the SBOM** keyless via Sigstore (Fulcio/Rekor) using the
     workflow's OIDC token.
     It also builds the single-file CLI and, when `NPM_TOKEN` is set, publishes
     `@codesentra/cli` to npm with **build provenance** (`npm publish --provenance`).
5. Create the GitHub Release from the tag; attach the SBOM artifacts and paste the changelog
   section.

### Secrets the workflow needs

- `GITHUB_TOKEN` (automatic) — push to GHCR.
- `NPM_TOKEN` — an npm automation token, only to publish the CLI. Absent → images are still
  built, scanned and signed; the CLI is built but not published.

## Verifying a release

Image signature and SBOM attestation (consumers and the deploy host should verify before
rolling out):

```sh
# Signature (keyless): check it was signed by this repo's release workflow.
cosign verify \
  --certificate-identity-regexp "https://github.com/santheesh73/Code-Sentra/.github/workflows/release.yml@.*" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/santheesh73/codesentra-api:v1.2.3

# SBOM attestation.
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp "https://github.com/santheesh73/Code-Sentra/.github/workflows/release.yml@.*" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/santheesh73/codesentra-api:v1.2.3
```

The CLI's npm provenance is shown on its npm package page and verifiable with `npm audit
signatures`.

## Rollback

Releases are forward-only in the registry, but rolling back is just pointing at the previous
tag — migrations are additive, so older code runs against the newer schema.
1. **App tier**: set the `*_IMAGE` tags in your env file back to the previous version and
   `docker compose -f infra/deploy/app.compose.yml up -d` (see
   [`deployment.md`](deployment.md#deploying-a-new-version)). On Render, use **Rollback** to the
   previous deploy.
2. **Scan VM**: set `WORKER_SCAN_IMAGE`/`SANDBOX_IMAGE` back and `up -d` there.
3. **Do not roll back the database.** A migration that must be undone is rare; prefer a
   forward fix. If a restore is unavoidable, use `scripts/backup-restore.sh` and rehearse first.
4. **CLI**: npm versions are immutable; publish a patch that reverts the change rather than
   unpublishing.

Verify `GET /health` and `/ready` and watch the workers log `ready` after any rollback.
