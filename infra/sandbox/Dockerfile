# CodeSentra sandbox image: runs untrusted project code (install, build, typecheck, lint,
# tests) with no network, no secrets and an unprivileged user (Section 8.4, ADR 0016).
# Toolchains: Python 3.12, the repo's pinned Node 22 with npm and corepack (pnpm/yarn), Go
# (ADR 0026), Ruby with Bundler, and Java 21 with Maven (ADR 0027). Keep the SANDBOX_*_VERSION
# constants in packages/scan/src/probe/plan.ts equal to these tags (a test checks).
FROM node:22.23.4-bookworm-slim AS node
FROM golang:1.27.2-bookworm AS go
FROM ruby:3.4.10-slim-bookworm AS ruby
FROM maven:3.9.12-eclipse-temurin-21 AS maven

FROM python:3.12.15-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=go /usr/local/go /usr/local/go
# Ruby: the interpreter, its library tree and the one shared library the Python base lacks.
COPY --from=ruby /usr/local/lib/ruby /usr/local/lib/ruby
COPY --from=ruby /usr/local/lib/libruby.so.3.4.10 /usr/local/lib/libruby.so.3.4.10
COPY --from=ruby /usr/lib/x86_64-linux-gnu/libyaml-0.so.2.0.9 /usr/lib/x86_64-linux-gnu/libyaml-0.so.2.0.9
COPY --from=ruby /usr/local/bin/ruby /usr/local/bin/gem /usr/local/bin/bundle /usr/local/bin/bundler /usr/local/bin/rake /usr/local/bin/
# Java and Maven (self-contained trees).
COPY --from=maven /opt/java/openjdk /opt/java/openjdk
COPY --from=maven /usr/share/maven /usr/share/maven
RUN ln -s libruby.so.3.4.10 /usr/local/lib/libruby.so.3.4 \
 && ln -s libyaml-0.so.2.0.9 /usr/lib/x86_64-linux-gnu/libyaml-0.so.2 \
 && ldconfig \
 && ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox \
 && mkdir /work && chown sandbox:sandbox /work
ENV HOME=/home/sandbox \
    PATH=/usr/local/go/bin:/opt/java/openjdk/bin:$PATH \
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
