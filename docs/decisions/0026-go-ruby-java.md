# 0026 — Phase 8: Go, Ruby and Java

- **Status:** accepted (Phase 8)

## Context

Section 5 puts parsing behind a parser interface, with "more later". The user chose more
languages for Phase 8. Each new language has to meet the same rules as TypeScript and
Python:
- facts come from exact syntax, never guesses;
- the dependency download runs no code (ADR 0016);
- anything that cannot run is a gap;
- each language gets a fixture repository with an `expected.json` checked by hand.

## Decision

- **Parsers.**
  - Grammars, all loaded by the repo's web-tree-sitter 0.27.1 and embedded in the
    single-file CLI: `tree-sitter-go` 0.25.0, `tree-sitter-ruby` 0.23.1 and
    `tree-sitter-java` 0.23.5.
  - Each extractor fills the same facts as the TypeScript and Python ones.

  | Fact                    | Go                                                                              | Ruby                                                                                  | Java                                                                                |
  | ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | Routes                  | `HandleFunc`/`Handle` (with Go 1.22 `"GET /x/{id}"`), Gin/Echo `GET`, Chi `Get` | Sinatra verbs; `config/routes.rb` verbs and `root`, with `namespace`/`scope` prefixes | Spring `@*Mapping` with the class `@RequestMapping` prefix; JAX-RS `@Path` + `@GET` |
  | Env reads               | `os.Getenv`, `os.LookupEnv`                                                     | `ENV[...]`, `ENV.fetch`                                                               | `System.getenv`                                                                     |
  | Env-built URL templates | `+`, `fmt.Sprintf`                                                              | interpolation, `+`                                                                    | `+`, `String.format`                                                                |
  | Tests                   | `TestX` + `t.Skip`                                                              | RSpec `it`/`xit`/`skip:`/`pending`, Minitest `test_*` + `skip`                        | `@Test` + `@Disabled`/`@Ignore`                                                     |
  | Stubs                   | `panic("not implemented")`                                                      | `raise NotImplementedError`                                                           | `throw new UnsupportedOperationException()`                                         |

- **Graph.** Each language resolves imports its own way:
  - Go imports resolve to the package's files, under the longest matching `go.mod`
    module path.
  - Ruby `require` resolves against `lib/`, `app/` and the repo root; `require_relative`
    against the requiring file.
  - Java types and wildcard packages resolve under every `src/{main,test}/java` root.

  A Go or Java test file also gets `tests` edges to its own package. The language lets it
  test that package without importing it; without these edges its passing tests never
  counted as covering.
- **Manifests**:
  - `go.mod`, `Gemfile`, `pom.xml` and `build.gradle` are read as text. A Gemfile and a
    build script are code, so they are never evaluated.
  - Framework detection: Gin, Echo, Chi, Fiber, Rails, Sinatra, Spring Boot, Jakarta REST.
  - The claim verifier knows these names, so a claim naming the wrong one is dropped.
- **Dependency audit** (OSV ecosystems `Go`, `RubyGems`, `Maven`):
  - Sources:
    - `go.mod` requires, with `replace` applied;
    - `Gemfile.lock` GEM specs;
    - `gradle.lockfile`;
    - the literal versions in `pom.xml` (with `${properties}`) and `build.gradle`.
      These two are direct-only, and that is reported as a gap.
  - RubyGems and Maven have their own version ordering. Go uses v-prefixed SemVer, and
    the `v` is stripped for the OSV API.
  - Entries without a pinned version (set by a parent POM, from a git source, a range)
    are now reported as a gap in every ecosystem. Before this they were silently left out.
- **Probes.**
  - **Go** runs in the sandbox. The image adds Go 1.27.2, and `SANDBOX_GO_VERSION` is
    kept equal to it by a test.
    - The download step is `go mod download`, which runs no code. It uses
      `GOPROXY=https://proxy.golang.org` only (no `direct`, so no VCS host is contacted),
      `GOSUMDB=sum.golang.org` and `GOTOOLCHAIN=local`.
    - Then, offline (`GOPROXY=off`, cgo off): `go mod verify`, `go build ./...`,
      `go vet ./...` (the lint step) and `go test -json ./...`.
    - A `go.mod` without `go.sum`, or one that needs a newer Go, is a gap.
  - **Ruby, Maven and Gradle** do not run. Bundler evaluates the Gemfile to download gems,
    and Maven and Gradle run plugins or build scripts while they resolve dependencies.
    Either way the download would run code, which ADR 0016 forbids. Every probe step is
    a gap that says so.
- **Fixtures.**
  - `go-shop-api` (chi), `rb-notes-api` (Sinatra) and `java-shop-api` (Spring Boot), each
    with a real advisory:
    - chi v5.2.1: GHSA-vrw8-fxc6-2r93;
    - rack 2.2.3: GHSA-hxqx-xwvh-44m2;
    - jackson-databind 2.13.2: GHSA-57j2-w4cx-62h2.
  - These were added to the offline OSV snapshot. The snapshot builder now merges
    ecosystems, so the npm and PyPI records did not change.
  - Fixtures whose probes cannot run declare install and build `skipped` and tests `null`.
    `TESTS_FAILING` is required only where tests run.

## Consequences

- Ruby and JVM projects get no build or test results until a download path that runs no
  code exists. Candidates are a vendored `vendor/cache` for Bundler, or a resolved
  dependency list that Maven's resolver could fetch without plugins. Each is its own
  decision.
- cgo-dependent Go packages fail to build in the sandbox, which has no C toolchain. That
  shows up as a build failure with the compiler's message.
- The sandbox image grows by about 300 MB with Go (the toolchain layer is 296 MB).
- The CLI bundle grows from 7.3 MB to 10.9 MB.
