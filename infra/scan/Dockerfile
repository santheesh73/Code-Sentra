# Sentra Scan worker image: worker-scan plus git (clones) and the Docker CLI. The CLI
# talks to a Docker daemon that runs the sandbox (gVisor runsc preferred) and gitleaks;
# the daemon is NOT in this image: mount a socket or set DOCKER_HOST (see docs/runbook.md).
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker-scan ./apps/worker-scan
COPY apps/cli/package.json ./apps/cli/package.json
COPY fixtures/harness/package.json ./fixtures/harness/package.json
COPY fixtures/apps ./fixtures/apps
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter "@codesentra/worker-scan..." \
 && pnpm --filter "@codesentra/worker-scan..." --filter "!@codesentra/fixture-harness" \
      --filter "!@codesentra/cli" --filter "!@fixtures/*" run build \
 && pnpm deploy --filter @codesentra/worker-scan --prod --legacy /out

FROM ${NODE_IMAGE} AS docker-cli
# Docker's static CLI, pinned and checksum-verified.
ARG DOCKER_VERSION=29.9.0
ARG DOCKER_SHA256=33e1ab8b63d14bca449f7a3d30d7f6aa669daa544e60a86b17fec87f61afe2b4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSLo /tmp/docker.tgz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
 && echo "${DOCKER_SHA256}  /tmp/docker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/docker.tgz -C /tmp docker/docker

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /tmp/docker/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/package.json ./package.json
# The node user must be in the group that owns the Docker socket on the host; the
# platform config adds it (group_add) rather than running this process as root.
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
