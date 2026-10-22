# 0016 — Sandbox, the dependency fetch step, git ingest and the OSV snapshot

- **Status:** accepted (Phase 3)

## Context

Rule 5: untrusted code runs only in a sandbox, and every outbound fetch is SSRF-checked.
Scan has to install dependencies, build and run tests of arbitrary repositories, clone
arbitrary git URLs, and look up dependency advisories, all reproducibly in CI.

## Decision

- **Sandbox (`packages/sandbox`).** Docker, using `runsc` (gVisor) when Docker has it and
  `runc` otherwise. With `SANDBOX_RUNTIME=runsc`, worker-scan refuses to fall back: probes
  become a gap instead. Every container gets:
  - `--network none`, a read-only root, `--cap-drop ALL`, `no-new-privileges`, and
    Docker's default seccomp profile;
  - uid 10001, pid/CPU/memory limits (no swap), and a size-capped `/tmp`;
  - only the run's scratch copy mounted, and none of the worker's environment.
    The image (`infra/sandbox/Dockerfile`) is Python 3.12.15 with Node 22.23.4 copied in.
- **Dependency fetch step.** Installing needs the network, but project code must never
  run with it. So the sandbox fetches once, in a separate container that runs no project
  code:
  - npm: `npm ci --ignore-scripts`, only if every lockfile URL is on
    `registry.npmjs.org` or `registry.yarnpkg.com`;
  - Python: `pip download --only-binary=:all:` from requirements with options, URLs and
    VCS references stripped.
    Every later step (install from the fetched cache, build, tests, typecheck, lint) runs
    with `--network none`. The fetch network is `bridge` by default; where egress needs a
    proxy, set `SANDBOX_FETCH_NETWORK=host`, `SANDBOX_FETCH_PROXY` and
    `SANDBOX_FETCH_CA_FILE`. A step that cannot run (no lockfile, a disallowed URL, a
    timeout) is a gap, not a pass.
- **Git ingest.** `git clone` runs with hardened `-c` config:
  - protocol allowlist, no submodules, no hooks, and no credential helpers;
  - the host resolved and checked by the same SSRF policy as Pulse (ADR 0013), then pinned
    with `http.curloptResolve`, so git cannot re-resolve to a private address.
    Proxy variables are removed from git's environment, because a proxy would bypass the pin.
    Only https is allowed; plain http is allowed only for `NODE_ENV=test` loopback hosts.
- **Zip ingest.** yauzl, with these limits:
  - rejected outright: entry and total-size caps, compression-ratio (bomb) checks, path
    traversal, absolute and drive paths, symlinks and encrypted entries;
  - a cap on the number of files.
    Each rejection has a code and a 24-test safety suite. The tree is never executed in place.
- **OSV.** `scripts/build-osv-snapshot.ts` builds `fixtures/osv` from the real
  `osv-vulnerabilities.storage.googleapis.com` dumps. It contains only the records for
  packages the fixtures (and tests) use, plus `SNAPSHOT.json` saying which packages it
  covers. A package the snapshot does not cover is reported as **not checked**, never
  "no advisories". Production uses the OSV API unless `OSV_OFFLINE_DIR` is set.
  Versions are evaluated with SemVer (npm) and PEP 440 (PyPI). GHSA and PYSEC aliases are
  merged.
- **Secrets.** gitleaks v8.30.1 runs in a container with no network, using `--redact`.
  Previews are masked from the source columns, so a secret value is never stored.

## Consequences

- CI runners have no gVisor, so CI uses `runc`. The isolation flags above are the same in
  both runtimes.
- The fetch step means install uses the network once, without running project code. A
  malicious package cannot run install scripts (`--ignore-scripts`). Its code runs later
  in the sandbox with no network.
- Refreshing the OSV snapshot is a deliberate, reviewed commit
  (`node packages/scan/scripts/build-osv-snapshot.ts fixtures/osv <lockfile>...`).
