# CodeSentra sandbox image: runs untrusted project code (install, build, typecheck, lint,
# tests) with no network, no secrets and an unprivileged user (Section 8.4, ADR 0016).
# Toolchains: Python 3.12, the repo's pinned Node 22 with npm and corepack (pnpm/yarn), and
# Go (ADR 0026; keep SANDBOX_GO_VERSION in packages/scan/src/probe/plan.ts equal).
FROM node:22.23.4-bookworm-slim AS node
FROM golang:1.27.2-bookworm AS go

FROM python:3.12.15-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=go /usr/local/go /usr/local/go
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox \
 && mkdir /work && chown sandbox:sandbox /work
ENV HOME=/home/sandbox \
    PATH=/usr/local/go/bin:$PATH \
    GOTOOLCHAIN=local \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CI=true
USER 10001:10001
WORKDIR /work
