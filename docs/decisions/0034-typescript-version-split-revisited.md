# 0034 — The TypeScript 7 / 6 split, revisited

- **Status:** accepted (remediation WS-5)
- **Supersedes:** the "Revisit once Next.js supports TS 7" note in ADR 0001.

## Context

ADR 0001 put workspace packages on TypeScript 7 (the Go-native compiler) and the Next.js apps
on TypeScript 6, because TS 7 shipped `tsc` but no JavaScript compiler API, which `next build`
used to type-check. The audit (F-14) noted the "revisit" had not happened since Phase 0. The
repo pins Next 16.4.2 and TypeScript 6.0.3 for `apps/web` and the fixture apps.

## What changed upstream

Next.js 16.3 added TypeScript 7 support in `next build`, but:
- it is **opt-in** via `experimental.useTypeScriptCli`, and requires TS 7's `tsc` CLI in the
  project (TS 7 still has no JS compiler API before 7.1, so Next's default checker cannot run);
- some 16.2.x builds **silently skipped** build-time type-checking when they detected the TS 7
  native preview, so enabling it can turn a previously-green build red once the check actually
  runs — the type-check stage must be confirmed to run.

Sources: [Next.js TypeScript config docs](https://nextjs.org/docs/app/api-reference/config/typescript),
[Next.js 16.3 + TypeScript 7 upgrade notes](https://www.achromatic.dev/blog/nextjs-16-3-typescript-7-upgrade).

## Decision

- **Keep the apps on TypeScript 6 for now.** Moving them to TS 7 is now possible on Next 16.3+,
  but only behind an experimental flag with a documented silent-skip risk. The cost of the split
  is low (two majors in one lockfile, already isolated to the apps' devDependencies), and the
  risk of a type-check silently not running is a direct hit to the honesty guarantee. The split
  stays until TS-7 support in Next is stable (non-experimental) and the JS compiler API gap
  (7.1) is closed.
- **Packages stay on TypeScript 7**, unchanged.
- **Migration path when we move**, recorded so the next revisit is mechanical: install TS 7 in
  each Next app, set `experimental.useTypeScriptCli: true`, run `next build`, and confirm the
  type-check stage ran by introducing a deliberate type error and seeing the build fail (guard
  against the silent-skip regression), then remove the TS 6 pins.

## Consequences

- No code change now; the decision is recorded and the Phase 0 "revisit" is closed with a
  concrete trigger (stable Next support + TS 7.1) and a migration checklist.
- A CI check could later assert the apps' `next build` fails on a planted type error; noted for
  the migration, not added now.
