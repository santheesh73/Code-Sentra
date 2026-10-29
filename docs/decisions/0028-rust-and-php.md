# 0028 — Phase 10: Rust and PHP

- **Status:** accepted (Phase 10)

## Context

The user chose Rust and PHP for Phase 10. They have to meet the same rules as the languages
before them (ADR 0026, ADR 0027):
- facts come from exact syntax;
- the networked dependency download runs no code (ADR 0016);
- anything that cannot run is a gap;
- each language gets a fixture repository with an `expected.json`.

## Decision

- **Parsers.**
  - Grammars, loaded by the repo's web-tree-sitter 0.27.1 and embedded in the single-file
    CLI: `tree-sitter-rust` 0.24.0 and `tree-sitter-php` 0.24.2. The PHP grammar used is
    the one that also reads inline HTML.
  - Each extractor fills the same facts as the others.

  | Fact                    | Rust                                                                                                                     | PHP                                                                                                                                             |
  | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | Routes                  | axum `.route("/x", get(h).post(h2))` with inline `.nest` prefixes; Actix `web::get().to(h)`; Actix/Rocket `#[get("/x")]` | Laravel `Route::get`/`match` with `prefix` groups; Slim/Lumen `$app->get`/`map` with `group` prefixes; Symfony `#[Route]` with the class prefix |
  | Env reads               | `env::var`, `env::var_os` (also inside macro arguments)                                                                  | `getenv`, `env()`, `$_ENV[...]`                                                                                                                 |
  | Env-built URL templates | `+`, `format!`                                                                                                           | `.`, `sprintf`                                                                                                                                  |
  | Tests                   | `#[test]`, `#[tokio::test]`, `#[rstest]` in any file; `#[ignore]` skips                                                  | PHPUnit `test*`/`#[Test]`/`@test` in a `TestCase`; `markTestSkipped`; Pest `test()`/`it()` with `->skip()`                                      |
  | Stubs                   | `todo!()`, `unimplemented!()`, `panic!("not implemented")`                                                               | `throw new LogicException('Not implemented')`, `BadMethodCallException`                                                                         |

- **Graph.**
  - Rust: `mod x;` resolves to `x.rs` or `x/mod.rs` next to the declaring module. A `use`
    path (`crate::`, `self::`, `super::`, or the crate's own name from `tests/`) resolves to
    the deepest module file it names, else the crate root. Crates come from each
    Cargo.toml's package name.
  - PHP: `use` resolves through the PSR-4 maps in composer.json (`autoload` and
    `autoload-dev`). `require`/`include` resolve against the file, and `__DIR__ . '/x'` is
    read as relative to it. Composer's `vendor/` is never committed, so requires into it
    are not reported as unresolved.
- **Manifests.** `Cargo.toml` is read as text and `composer.json` as JSON. Detected
  frameworks: Axum, Actix Web, Rocket, Laravel, Slim and Symfony. The claim verifier knows
  their names.
- **Dependency audit** (OSV ecosystems `crates.io` and `Packagist`):
  - `Cargo.lock` packages from the crates.io registry. The workspace's own crates are
    skipped; git and other registries are listed as not audited.
  - `composer.lock` `packages` and `packages-dev`, with the tag's `v` dropped. `dev-*`
    branches are listed as not audited.
- **Rust probes.**
  - The toolchain is Rust 1.99.0 with Clippy, put on `PATH` directly with no rustup proxy,
    so a project's `rust-toolchain` file cannot select another toolchain.
  - The project's `.cargo/` is set aside: it can set wrappers, linkers, registries and
    source replacement. `CARGO_HOME` is ours, `RUSTC` is fixed, and the wrapper variables
    are emptied.
  - The download is `cargo fetch --locked`. It downloads the crates Cargo.lock pins and
    checks them against its checksums, and runs no build script or proc macro. A lockfile
    with git or other registry sources is refused, and a project without Cargo.lock is a
    gap.
  - Then, offline (`--frozen`): `cargo metadata` (install), `cargo build`,
    `cargo clippy --all-targets -- -D warnings` (lint) and `cargo test --no-fail-fast`.
    Build scripts and proc macros are project code, and they run only here.
  - Gaps: a crate needing a newer Rust, or a system library found with pkg-config.
- **PHP probes.**
  - The download is our own script, run with `python -I`; Composer does not run.
    - It reads only composer.lock. Each package must be the zip of a locked commit on
      GitHub (Packagist's default for public packages). The URL is rewritten to
      codeload.github.com, which serves it without the GitHub API's rate limit.
    - Redirects are refused. The lockfile's sha1 is checked where present; Packagist
      usually leaves it empty, and the fetch reason says so.
    - Each zip is unpacked into `vendor/`: entries that would leave it are refused, and
      symlinks are skipped.
    - The planner writes `vendor/composer/installed.json` from the lock.
    - Other hosts, source-only packages and odd names are refused. A project with
      dependencies but no composer.lock is a gap.
  - `auth.json` and `.composer/config.json` are set aside.
  - Then, offline, with Composer's network disabled:
    - `composer dump-autoload --no-scripts --no-plugins` (install);
    - `php -l` on every project file (build);
    - PHPStan or Psalm when locked and configured (typecheck);
    - PHP-CS-Fixer or PHP_CodeSniffer (lint);
    - Pest or PHPUnit (tests). PHPUnit's failure sections are read; its skipped
      section is not.
  - Gap: the project needs a PHP version or extension the sandbox lacks.
- **Sandbox image.**
  - Adds Rust 1.99.0 with Clippy, PHP 8.4.27 and Composer 2.10.3, taken from their
    official images by tag.
  - Rust links through the C compiler. gcc 12 and libc6-dev are copied from the rust
    image's own Debian packages (the same Debian release as the base) with `dpkg -L`.
    PHP's shared libraries come from the php image the same way. No network is needed.
  - `rustup component add clippy` is the one networked build step. An optional
    `build-ca` secret lets the build trust a TLS-intercepting proxy. It is never part of
    the image.
  - The `SANDBOX_*_VERSION` constants are kept equal to the Dockerfile by a test.
- **Fixtures.**
  - `rs-notes-api` (axum) and `php-notes-api` (Slim), with the same features, markers and
    tests as `rb-notes-api`.
  - Real advisories:
    - smallvec 1.6.0: GHSA-43w2-9j62-hq99 / RUSTSEC-2021-0003;
    - guzzlehttp/psr7 2.4.4: GHSA-wxmh-65f7-jcvw.
  - Both were added to the offline OSV snapshot. The other ecosystems' records did not
    change.

## Consequences

- **PHP downloads trust GitHub.** Integrity is TLS plus the pinned commit, and a sha1
  only where the lock has one. Packages hosted elsewhere (GitLab, Bitbucket, private
  Composer repositories) are refused, so their projects get a gap.
- **Composer plugins never run.** A package that needs a plugin (custom installers,
  generated files) may not work offline. The failing step shows why.
- **Route prefixes outside the syntax are not applied:**
  - Laravel's `/api` prefix for `routes/api.php`, which the framework's configuration
    adds;
  - Rocket's `mount` prefixes;
  - axum routers nested from another function.

  Routes are reported as written.
- **The sandbox now has a C compiler** (for Rust).
  - Native gems still cannot build: there is no `make` and no Ruby headers. The gap
    reason now says so.
  - Go keeps `CGO_ENABLED=0`.
- **Build time.** The Rust fixture fetches, builds, lints and tests in about 40 s. Large
  workspaces can exceed the 10-minute probe budget, which is reported as a timeout.
- **Size.** The sandbox image grows from 1.35 GB to 2.56 GB, and the CLI bundle from
  10.9 MB to 14.4 MB.
- **Verification.** This development session's egress policy blocks GitHub archive
  downloads and Debian's mirrors. So the PHP download, and the PHPUnit run that depends on
  it, are exercised by CI only. Every other PHP step was run by hand in the sandbox image.
