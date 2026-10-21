# 0003 — Each service validates only the variables it uses

- **Status:** accepted (Phase 0)

## Context

Section 20 lists the required variables, but not every process needs every one. A
Pulse worker has no use for Slack or Anthropic credentials, and handing them over widens
the blast radius of a compromised worker.

## Decision

`packages/config` defines one Zod schema covering every variable. `SERVICE_ENV` maps each
service (`api`, `web`, `worker-scan`, `worker-pulse`, `worker-link`) to the subset it must
have. `loadConfig(service)`:
- reports every problem at once, and never echoes values;
- rejects placeholders (`change-me`, `changeme`, `your-…`, `xxx`, `<…>`, …), empty strings
  and malformed values (a 32-byte base64 `ENCRYPTION_KEY`, a PEM `GITHUB_APP_PRIVATE_KEY`,
  a `postgres://` URL, `SANDBOX_RUNTIME ∈ {runsc, runc}`);
- returns only that service's variables.

A test keeps `.env.example` in sync with the schema. `POSTGRES_PASSWORD` is the single
compose-only exception.

## Consequences

When a service needs a new variable, add it to both the schema and `SERVICE_ENV`.
