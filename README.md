# CodeSentra

CodeSentra answers two questions about a software project and joins the answers into
an exact, verifiable fix:
- **Sentra Scan:** what is this project, what is complete, what is remaining, and what is wrong?
- **Sentra Pulse:** is the deployed app live, down, or quietly broken?
- **Sentra Link:** where in the code does each problem come from, how do we fix it, and how
  do we prove the fix?

**Status:** Phase 0 (fixtures and skeleton). The product modules are not built yet; see
[`docs/progress.md`](docs/progress.md).

```sh
pnpm install
pnpm build && pnpm test   # includes the browser-based fixture gate (needs Chromium)
pnpm fixtures:serve       # serve the fixture apps and failure simulators locally
```

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/decisions/`](docs/decisions/)
- Environment: [`.env.example`](.env.example)
