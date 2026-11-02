# 0036 — gitleaks allowlist scope and the planted fixture secrets

- **Status:** accepted (remediation WS-5)

## Context

CodeSentra's own secret scan (gitleaks, in CI) must not flag the **deliberately planted** fake
credentials in the Scan fixture repositories under `fixtures/repos/`, which exist so Scan can
detect them. The audit (follow-up 1) noted the allowlist is scoped to `^fixtures/repos/` —
narrower than the spec's broader suggestion — and asked to confirm the planted keys cannot
trip GitHub push protection, and to record both.

## Decision

- **The gitleaks allowlist stays scoped to `fixtures/repos/`** (`.gitleaks.toml`), plus one
  historical fingerprint in `.gitleaksignore` for a fake bypass value that was committed once
  and immediately replaced. Narrow is deliberate: only the fixtures carry intentional secrets,
  so only they are exempt; the rest of the repository is scanned with gitleaks' defaults. This
  is accepted as narrower-than-spec because it is safer, not weaker.
- **Planted AWS-style keys use a `AKIACODESENTRAFIX…` prefix** and are paired only with
  obviously fake secret values, so they are non-functional. They have been committed to the
  GitHub repository (they are in `main`), which is evidence they did not trip push protection
  in this repository's configuration; GitHub/AWS also treat clearly non-example keys as secrets
  only when a plausible secret-access-key accompanies them, which the fixtures avoid.

## Consequences

- CI's secret scan is clean while Scan's fixtures still contain the secrets it must find.
- If a future fixture needs a planted credential in a format GitHub push protection blocks, add
  it in a form paired with a non-functional secret, or push via a branch exempt from push
  protection; do not widen the gitleaks allowlist beyond `fixtures/repos/`.
- Keeping the allowlist narrow means a real secret committed outside the fixtures is still
  caught by CI.
