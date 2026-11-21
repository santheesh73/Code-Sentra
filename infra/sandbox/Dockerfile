# CodeSentra sandbox image: runs untrusted project code (install, build, typecheck, lint,
# tests) with no network, no secrets and an unprivileged user (Section 8.4, ADR 0016).
# Toolchains: Python 3.12, the repo's pinned Node 22 with npm, CodeSentra's own pinned pnpm
# and Yarn releases (no Corepack: a project's packageManager field never picks one, ADR 0030), Go
# (ADR 0026), Ruby with Bundler, Java 21 with Maven (ADR 0027), Rust with Cargo and Clippy, and
# PHP with Composer (ADR 0028). Keep the SANDBOX_*_VERSION constants in
# packages/scan/src/probe/plan.ts equal to these tags (a test checks).
# Every base is digest-pinned (@sha256) as well as tagged (re-audit L-1): this image runs
# untrusted project code, so the toolchain it ships must be byte-for-byte reproducible and not
# follow a tag that an upstream re-push could move. To bump a base, change the version tag AND the
# digest together: resolve the new manifest-list digest with
# `docker buildx imagetools inspect <image>:<tag>` (or the registry API) and update both.
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS go
FROM ruby:3.4.10-slim-bookworm@sha256:a53b923c4d7ae2a927f766b3e71a9512d034ebec65931c0c34254de8768e7671 AS ruby
FROM maven:3.9.12-eclipse-temurin-21@sha256:c3c9d3ac4ce8431a3995c0318b8d390f448e693dd4fabc16e9b68d2e1f3d7b46 AS maven
# Rust, Cargo and Clippy. The non-slim image ships the default rustup profile, so clippy and
# rustfmt are already in the toolchain — we add no rustup component, so the image builds with NO
# network egress to static.rust-lang.org (re-audit N-3; a probe test asserts no component is added
# at build time). The toolchain dir copied below (/opt/rust) therefore already includes clippy.
FROM rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS rust
# Package managers for Node projects, pinned and checked against the registry's sha512
# (ADR 0030). Each lockfile format gets the release that reads it: pnpm 7 (lockfile 5.x), pnpm
# 8 (6.x), pnpm 10 (9.x), Yarn 1 (classic lockfiles) and Yarn 4 (Berry lockfiles).
# The `build-ca` secret below is optional: the CA of a TLS-intercepting egress proxy, for builds
# behind one (docker build --secret id=build-ca,src=ca.pem). It is never part of the image.
FROM node AS pms
RUN --mount=type=secret,id=build-ca \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca npm_config_cafile=/run/secrets/build-ca; fi \
 && mkdir -p /opt/codesentra/pm /tmp/pm && cd /tmp/pm \
 && printf '%s\n' \
      'pnpm-7.33.5 pnpm/-/pnpm-7.33.5.tgz sha512-TkmfIv/+WEWqj5Rj4ThrLXLDE04OvvlAk2CthE/vApDoK0ebMusuwPMOVmB+GCDCIWeCn9YmVtQaj9DMSg9CZw==' \
      'pnpm-8.15.9 pnpm/-/pnpm-8.15.9.tgz sha512-SZQ0ydj90aJ5Tr9FUrOyXApjOrzuW7Fee13pDzL0e1E6ypjNXP0AHDHw20VLw4BO3M1XhQHkyik6aBYWa72fgQ==' \
      'pnpm-10.34.9 pnpm/-/pnpm-10.34.9.tgz sha512-9JtajqD97bRLs8DB1ldQkqU8KVDZW3rRXfEfF5dId6LeOgHAfpNOmyjOcW5RwJqUlixzBtCb4uHksYqMh2L9Mg==' \
      'yarn-1.22.22 yarn/-/yarn-1.22.22.tgz sha512-prL3kGtyG7o9Z9Sv8IPfBNrWTDmXB4Qbes8A9rEzt6wkJV8mUvoirjU0Mp3GGAU06Y0XQyA3/2/RQFVuK7MTfg==' \
      'yarn-4.18.1 @yarnpkg/cli-dist/-/cli-dist-4.18.1.tgz sha512-EH+A4TxAtBWXKE0DGQxW9Bo9crXHLJ73mfxjTQJuv8XonNWWTpei8BQ5JjczHJNU9GROTycwMFn8iOvRIZXUcA==' \
    > list \
 && while read -r dir path sri; do \
      npm pack --silent "https://registry.npmjs.org/$path" >/dev/null \
   && f=$(ls -t *.tgz | head -1) \
   && got="sha512-$(node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$f")" \
   && [ "$got" = "$sri" ] || { echo "$path: checksum mismatch ($got)"; exit 1; } \
   && mkdir "/opt/codesentra/pm/$dir" && tar -xzf "$f" -C "/opt/codesentra/pm/$dir" --strip-components=1 && rm "$f"; \
    done < list
FROM php:8.4.27-cli-bookworm@sha256:b3e907a1108629c562c4bb313ce3449e34d49991f6bb2487913f6146f47200fe AS php
FROM composer:2.10.3@sha256:2cf275428757e5435a667bfc0d038b14520ca02be2b1b70d44a05c8c19e2de48 AS composer

# Debian packages taken from those images (same Debian release as the base) without a
# network: every file `dpkg -L` lists for them, docs left out. The C compiler and linker that
# Rust links through (and native gems build with), from the rust image; the shared libraries
# PHP was built against, and make, from the php image.
FROM rust AS cc
RUN mkdir /out && dpkg -L binutils binutils-common binutils-x86-64-linux-gnu cpp cpp-12 gcc gcc-12 \
      libasan8 libatomic1 libbinutils libc-dev-bin libc6-dev libcc1-0 libcrypt-dev libctf-nobfd0 \
      libctf0 libgcc-12-dev libgomp1 libgprofng0 libisl23 libitm1 libjansson4 liblsan0 libmpc3 \
      libmpfr6 libnsl-dev libquadmath0 libtirpc-dev libtsan2 libubsan1 linux-libc-dev rpcsvc-proto \
    | while read -r f; do if [ -f "$f" ] || [ -L "$f" ]; then echo "$f"; fi; done \
    | grep -v '^/usr/share/\(doc\|man\|info\|locale\|lintian\|bug\)/' | tar -cf - -T - | tar -xf - -C /out
FROM php AS phplibs
RUN mkdir /out && dpkg -L libargon2-1 libbrotli1 libcurl4 libicu72 libldap-2.5-0 libnghttp2-14 \
      libonig5 libpsl5 librtmp1 libsasl2-2 libsasl2-modules-db libsodium23 libssh2-1 libxml2 make \
    | while read -r f; do if [ -f "$f" ] || [ -L "$f" ]; then echo "$f"; fi; done \
    | grep -v '^/usr/share/\(doc\|man\|info\|locale\|lintian\|bug\)/' | tar -cf - -T - | tar -xf - -C /out

FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=pms /opt/codesentra/pm /opt/codesentra/pm
COPY --from=go /usr/local/go /usr/local/go
# Ruby: the interpreter, its library tree and the one shared library the Python base lacks.
COPY --from=ruby /usr/local/lib/ruby /usr/local/lib/ruby
# Ruby's headers, so gems with native extensions build offline (with make and gcc, below).
COPY --from=ruby /usr/local/include/ruby-3.4.0 /usr/local/include/ruby-3.4.0
COPY --from=ruby /usr/local/lib/libruby.so.3.4.10 /usr/local/lib/libruby.so.3.4.10
COPY --from=ruby /usr/lib/x86_64-linux-gnu/libyaml-0.so.2.0.9 /usr/lib/x86_64-linux-gnu/libyaml-0.so.2.0.9
COPY --from=ruby /usr/local/bin/ruby /usr/local/bin/gem /usr/local/bin/bundle /usr/local/bin/bundler /usr/local/bin/rake /usr/local/bin/
# Java and Maven (self-contained trees).
COPY --from=maven /opt/java/openjdk /opt/java/openjdk
COPY --from=maven /usr/share/maven /usr/share/maven
# Rust: the toolchain directory itself, with no rustup proxy, so a project's rust-toolchain
# file cannot select another toolchain.
COPY --from=rust /usr/local/rustup/toolchains/1.99.0-x86_64-unknown-linux-gnu /opt/rust
# PHP: the interpreter, its extensions and ini directory; Composer is a PHP archive.
COPY --from=php /usr/local/bin/php /usr/local/bin/php
COPY --from=php /usr/local/lib/php /usr/local/lib/php
COPY --from=php /usr/local/etc/php /usr/local/etc/php
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY --from=cc /out /
COPY --from=phplibs /out /
RUN ln -s gcc /usr/bin/cc \
 && ln -s libruby.so.3.4.10 /usr/local/lib/libruby.so.3.4 \
 && ln -s libruby.so.3.4.10 /usr/local/lib/libruby.so \
 && ln -s libyaml-0.so.2.0.9 /usr/lib/x86_64-linux-gnu/libyaml-0.so.2 \
 && ldconfig \
 && ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox \
 && mkdir /work && chown sandbox:sandbox /work
ENV HOME=/home/sandbox \
    PATH=/usr/local/go/bin:/opt/java/openjdk/bin:/opt/rust/bin:$PATH \
    GOTOOLCHAIN=local \
    JAVA_HOME=/opt/java/openjdk \
    MAVEN_HOME=/usr/share/maven \
    GEM_HOME=/home/sandbox/.gem \
    BUNDLE_VERSION=system \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CI=true
USER 10001:10001
WORKDIR /work
