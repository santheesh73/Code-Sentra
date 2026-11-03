# 0035 — Mailpit for development email

- **Status:** accepted (remediation WS-5)

## Context

The audit's follow-up 6 asked for a real mail inbox in development instead of only the
outbox-file transport. The outbox writes each message as a JSON file — fine for CI and tests
reading a known directory, but there is no inbox to open during manual QA, and no SMTP path is
exercised.

## Decision

- **A small SMTP transport** (`smtpTransport`, `packages/notify/src/email.ts`): a
  dependency-free SMTP client (EHLO / MAIL / RCPT / DATA / QUIT over `node:net`), building a
  `multipart/alternative` message, CRLF-normalized and dot-stuffed. It targets a local,
  unauthenticated server, so it is for development only; `packages/config` refuses
  `EMAIL_TRANSPORT=smtp` in production, as it does `outbox`.
- **Mailpit in docker-compose**: `axllent/mailpit`, SMTP on 1025, web inbox on
  http://localhost:8025. The compose app env uses `EMAIL_TRANSPORT=smtp` pointing at it, so a
  developer running `pnpm stack:up` reads sign-in mail in the inbox.
- **Unit tests keep the outbox and in-memory transports.** The e2e stack also keeps the outbox
  transport (it already reads the magic link from the outbox directory), so this change does
  not alter e2e; Mailpit is for manual dev and is available to e2e over its HTTP API if a test
  later prefers it. Production uses Resend.

## Consequences

- Manual sign-in and notification flows are visible in a real inbox in development, over a real
  SMTP path, without adding a mail library to the dependency tree.
- The SMTP transport is minimal by design (local, no auth, no TLS); it is not a production
  sender and config enforces that. The transport is unit-tested against an in-process SMTP
  stub, including a server refusal and dot-stuffing of a lone "." line.
