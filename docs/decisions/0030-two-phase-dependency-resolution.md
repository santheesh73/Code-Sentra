# 0030 — Two-phase dependency resolution

- **Status:** accepted (remediation WS-1)
- **Supersedes:** the Node parts of ADR 0016's dependency fetch step.

## Context

The independent audit (audit F-01) found that the networked dependency-download step ran
code from the scanned repository. A hostile `.pnpmfile.cjs`, a `.yarnrc` `yarn-path`, a
`.yarnrc.yml` `yarnPath`/`plugins`, or a `packageManager` field made the package manager
load and run project-supplied code while the container had the network. It also found
(F-03) that only npm lockfile URLs were checked, so a `yarn.lock` or `pnpm-lock.yaml` could
point a download at an internal host; (F-04) that the fetch container could reach the whole
worker network; and (F-05) that a network failure during the download was reported to the
user as a `BUILD_FAILED` finding against their code.

The other ecosystems (pip, Go, Bundler, Maven, Cargo, Composer) already downloaded without
running project code, each with its own script. The hole was the Node package managers,
which were driven through Corepack in the project's own working tree.

## Decision

Dependency resolution runs in two phases. **No scanned-repository code runs while the
network is on.**
- **The download runs in a manifest-only directory.** For Node, a fresh directory is filled
  with only the dependency manifests and lockfiles (`package.json`, `package-lock.json`,
  `pnpm-lock.yaml`, `yarn.lock`, and the equivalents for the other ecosystems), selected by
  exact file name. No `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, `.yarn/`, `.pnp.*`,
  `setup.py` or any script is present, so none can take part in the download. Rust keeps
  empty placeholders for its `.rs` files so Cargo discovers the same targets with no source.
- **The download uses CodeSentra's own pinned package managers**, baked into the sandbox
  image under `/opt/codesentra/pm` and checked against the registry's sha512 at build time:
  npm, pnpm 7/8/10 (chosen by the lockfile version), Yarn 1 (classic) and Yarn 4 (Berry).
  Corepack is removed from the image, and a project's `packageManager` field cannot select a
  binary (pnpm's `manage-package-manager-versions` is disabled). Every command takes its
  configuration from flags and an explicit environment, never a project config file, with
  install scripts and package-manager hooks disabled and the lockfile frozen.
- **Lockfile sources are checked before any download** (`probe/sources/`). Every
  `resolved`/`resolution`/`tarball`/`dist.url` in a package-lock, pnpm lockfile, Yarn classic
  or Berry lockfile, `poetry.lock` or `composer.lock` must be HTTPS on the default port, with
  no credentials, on an allowlisted registry host, never an IP literal. Git, `file:`, `link:`
  outside the workspace, `portal:`, `exec:`, repository patch files and unrecognised shapes
  are refused, naming the dependency; nothing is fetched.
- **The download has an egress allowlist** (`infra/egress-proxy/`). In production the fetch
  container joins an internal Docker network whose only route out is a Squid forward proxy
  that allows HTTPS `CONNECT` to the package registries alone, on port 443, without
  intercepting TLS. It has no route to the worker network, the database, object storage,
  cloud metadata or the internet at large.
- **The install runs offline.** The download fills a cache, which is copied into the full
  snapshot; the install, build, typecheck, lint and tests run in the sandbox with
  `--network none`, reading only that cache. Project install scripts run here, offline, as
  before. The project's own config and hook files are set aside in the work tree so neither
  the offline install nor the probes execute them.
- **Download failures are classified** (`probe/classify.ts`). A network, egress, TLS or
  timeout failure is a coverage gap: the install is Unverified, not a finding against the
  project. A manifest or lockfile error (a missing version, a corrupt artifact, a lockfile
  out of sync) is a real `BUILD_FAILED`, with the tool's own message. An unrecognised failure
  is treated as a gap, so the project is never blamed for a failure CodeSentra cannot
  attribute to it.

## Consequences

- **Node downloads can no longer run repository code**, even for a crafted repository. The
  isolation test suite (`probe/isolation.test.ts`) runs each hostile case through the real
  planner, runner and sandbox and asserts that no marker file appears after a networked
  container and that a canary server is never reached.
- **A legitimate `.pnpmfile.cjs` hook does not run** during analysis. Hooks that rewrite
  dependency resolution are not needed to measure a project, and the loss is accepted.
- **The pinned package managers must be kept current.** New major lockfile formats need a new
  pinned binary; the versions live in `infra/sandbox/Dockerfile` and `probe/node.ts`.
- **The egress allowlist must track the registries.** Adding an ecosystem means adding its
  registry host to `infra/egress-proxy/allowed-hosts.txt`.
- **Still downloaded in the full tree (not manifest-only):** pip, Go, Bundler, Maven, Cargo
  and Composer, whose existing scripts already run no project code (ADR 0016, 0026–0029) and
  need the whole tree; their lockfile sources are checked by the same validator where a
  lockfile URL applies.
