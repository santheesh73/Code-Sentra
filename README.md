# CodeSentra

CodeSentra answers two questions about a software project and joins the answers into
an exact, verifiable fix:
- **Sentra Scan:** what is this project, what is complete, what is remaining, and what is wrong?
- **Sentra Pulse:** is the deployed app live, down, or quietly broken?
- **Sentra Link:** where in the code does each problem come from, how do we fix it, and how
  do we prove the fix?

**Status:** Phase 2 (Sentra Pulse). Paste a URL, or check a project environment, and get
`live`, `degraded`, `down` or `unverified`, with evidence-backed issues and a fix prompt for
each. This works in the dashboard and with `codesentra pulse <url>`. Scan and Link are not
built yet; see [`docs/progress.md`](docs/progress.md).

```sh
pnpm install
pnpm build && pnpm test   # includes the browser-based fixture gate (needs Chromium)
pnpm fixtures:serve       # serve the fixture apps and failure simulators locally
node apps/cli/dist/main.js pulse https://example.com --fix-prompt
```

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/decisions/`](docs/decisions/)
- Environment: [`.env.example`](.env.example)
