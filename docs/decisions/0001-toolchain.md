# 0001 — Toolchain and TypeScript versions

- **Status:** accepted (Phase 0)

## Context

The kickoff asks for the latest stable release of each tool. On 2026-10-21 that is
TypeScript 7.0.2, the Go-native compiler. Its npm package ships `tsc` but **no JavaScript
compiler API** (`require("typescript")` fails). Next.js 16 calls that API during
`next build` to typecheck.

## Decision

- Workspace packages (`packages/*`, `fixtures/harness`, and later `apps/api` and the workers) use
  **TypeScript 7.0.2** for `tsc` builds and typechecks.
- Next.js apps (`fixtures/apps/*`, and later `apps/web`) pin **TypeScript 6.0.3** as a
  devDependency until Next supports TS 7.
- Lint and format: **Biome 2.6** instead of ESLint + Prettier (one tool, fast; the kickoff allows either).
- Tests: Vitest 5. Monorepo: pnpm 10 workspaces + Turborepo 2.
- Packages are ESM, built with `tsc` to `dist/`. Turborepo's `test` and `typecheck` tasks
  depend on `^build`.

## Consequences

Two TypeScript majors live in one lockfile. Revisit once Next.js supports TS 7.
