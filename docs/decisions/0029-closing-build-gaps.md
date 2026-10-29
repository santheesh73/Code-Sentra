# 0029 — Phase 11: closing the build gaps

- **Status:** accepted (Phase 11)

## Context

ADR 0027 and ADR 0028 left three gaps. The user chose to close them in Phase 11:
- **Maven parent POMs.** A parent POM fetched from Maven Central could declare build
  extensions, which Maven loads and runs when it starts. The planner saw only the project's
  own POMs.
- **Native gems.** Gems with native extensions could not build. The sandbox had no `make`
  and no Ruby headers; Phase 10 added gcc.
- **PHP packages outside GitHub.** Any other host was refused, with a terse reason.

## Decision

- **Maven extensions are judged as Maven loads them.** The same rules apply to the
  project's own POMs, in the planner, and to the whole parent chain, in the download:
  - `<build><extensions>` entries, and build plugins marked `<extensions>true</extensions>`,
    are refused.
  - A `pluginManagement` entry marked so is refused only when some POM in the build uses
    that plugin. Spring Boot's parent manages `native-maven-plugin` this way, so it alone is
    not a reason.
  - Inside a profile, only a profile with an `<activation>` counts. Probes never pass `-P`,
    and the settings file is ours.

  The earlier in-tree check matched the text `<extensions>true</extensions>` anywhere. That
  refused POMs Maven would build safely, and it is replaced by these rules.
- **The parent chain is checked before Maven starts.**
  - The download step first runs our own script, with `python -I`.
  - It fetches each external parent POM, and that POM's parents, from Maven Central. Each
    is checked against Central's sha1, and 429s and 5xx answers are retried with backoff.
  - It then applies the rules to the project's POMs and the chain together.
  - Parents that are in the tree are read from the tree. A parent not named by a plain
    groupId, artifactId and version (`${revision}`) is refused by the planner.
- **Our download scripts can refuse at run time.** A script prints
  `codesentra-refused: <reason>` and exits non-zero. The runner then reports the download
  as refused, with that reason, instead of failed, and nothing after it runs.
- **Native gems build offline.**
  - The sandbox image adds `make` (from the php image's Debian package, like gcc in ADR
    0028), Ruby's headers and the `libruby.so` link name.
  - `bundle install --local` then compiles extensions offline. They are dependency code,
    and they run only in the sandbox.
  - A native build that still fails is a gap, reported with the output: usually a system
    library the sandbox lacks.
- **PHP packages from GitLab.com are downloaded too.** That means the
  `gitlab.com/api/v4/projects/<project>/repository/archive.zip?sha=<commit>` form Packagist
  publishes, pinned to a commit, fetched with redirects refused. Other hosts get a reason
  that names the host and what is accepted.
- **Fixture.** `rb-notes-api` adds bcrypt 3.1.22, a gem with a C extension. Its build now
  compiles it offline in the gate. 3.1.22 is the version that fixes GHSA-f27w-vcwj-c954, so
  the fixture's only planted advisory stays rack's.

## Consequences

- **Spring Boot projects keep building.** The parent check costs one download per parent.
  Central rate-limits bursts, and the retries absorb that.
- **The extension rules read POMs with patterns,** like the rest of the Maven planner.
  - A plugin's configuration that itself contains `<plugin>` elements could be misread.
    That errs toward refusing.
  - Profile activation is not evaluated: any activation counts as active.
- **Native extensions now run during install.** They ran before only as far as the failure
  that made them a gap. They are third-party code and run with the same sandbox limits as
  the project's tests.
- **Still open:** Gradle (ADR 0027), private PHP repositories, and cgo (Go keeps
  `CGO_ENABLED=0`).
