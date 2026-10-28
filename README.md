# CodeSentra

CodeSentra answers two questions about a software project and joins the answers into
an exact, verifiable fix:
- **Sentra Scan:** what is this project, what is complete, what is remaining, and what is wrong?
- **Sentra Pulse:** is the deployed app live, down, or quietly broken?
- **Sentra Link:** where in the code does each problem come from, how do we fix it, and how
  do we prove the fix?

**Status:** Phase 6 (the Phase 1–5 gaps closed; ADR 0024).
- **Pulse:** paste a URL, or check a project environment, and get `live`, `degraded`,
  `down` or `unverified`, with evidence-backed issues and a fix prompt for each.
- **Scan:** upload a zip or point at a public repository. You get:
  - a code map;
  - install, build and tests run in a sandbox;
  - dependency advisories and committed secrets;
  - a feature inventory (complete, partial or planned);
  - a health score;
  - a report in which every sentence cites evidence, and unverifiable claims are dropped.
- **Link:** a full check (Scan + Pulse, then Link) traces each issue to the exact file and
  line by exact matches only. You get a `code_fix` prompt with the env vars and blast
  radius involved, and the issue closes on its own once the fix is deployed (and reopens
  if it comes back).
- **GitHub:** pull requests get a "CodeSentra" check run with each new issue and its prompt;
  preview deployments are checked by Pulse into the same check run.
- **Schedules and alerts:** recurring Pulse or full checks; email and Slack alerts carry
  every new or regressed issue's prompt.
- **Where:** in the dashboard, and from the CLI (`codesentra pulse`, `scan`, `login`,
  `check --project <id> --wait`), which also builds as one file for npm.

Deploying needs accounts and secrets only you can provide: see
[`docs/runbook.md`](docs/runbook.md). Section 17 is mapped to code and tests in
[`docs/security.md`](docs/security.md); status and known gaps are in
[`docs/progress.md`](docs/progress.md).

```sh
pnpm install
pnpm build && pnpm test   # includes the browser-based fixture gate (needs Chromium)
pnpm fixtures:serve       # serve the fixture apps and failure simulators locally
node apps/cli/dist/main.js pulse https://example.com --fix-prompt
docker build -t codesentra/sandbox:latest infra/sandbox
node apps/cli/dist/main.js scan path/to/project --fix-prompt
pnpm stack:up             # or: the whole app in docker-compose on http://localhost:3000
```

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/decisions/`](docs/decisions/)
- Environment: [`.env.example`](.env.example)
