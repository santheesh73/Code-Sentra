# Production image for a Node service of the monorepo: the API or worker-link.
#   docker build -f infra/node/Dockerfile --build-arg SERVICE=api -t codesentra/api .
#   docker build -f infra/node/Dockerfile --build-arg SERVICE=worker-link -t codesentra/worker-link .
# worker-pulse (Chromium) and worker-scan (Docker CLI, git) have their own images.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

FROM ${NODE_IMAGE} AS build
ARG SERVICE
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1
RUN test -n "$SERVICE" || (echo "--build-arg SERVICE=api|worker-link is required" && exit 1)
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/${SERVICE} ./apps/${SERVICE}
# Workspace packages that are only devDependencies, present so links resolve.
COPY apps/cli/package.json ./apps/cli/package.json
COPY fixtures/harness/package.json ./fixtures/harness/package.json
COPY fixtures/apps ./fixtures/apps
# Optional build secret `extra_ca`: a CA bundle for networks with a TLS-intercepting proxy.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter "@codesentra/${SERVICE}..." \
 && pnpm --filter "@codesentra/${SERVICE}..." --filter "!@codesentra/fixture-harness" \
      --filter "!@codesentra/cli" --filter "!@fixtures/*" run build \
 && pnpm deploy --filter "@codesentra/${SERVICE}" --prod --legacy /out

FROM ${NODE_IMAGE}
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/package.json ./package.json
# The entry file differs: the API is dist/server.js, workers dist/main.js.
RUN if [ -f dist/server.js ]; then ln -s server.js dist/entry.js; else ln -s main.js dist/entry.js; fi \
 && mkdir -p /outbox && chown node:node /outbox
USER node
# Container healthcheck for the API: hits its own /health (DB + queue liveness). worker-link,
# built from this same image, has no HTTP server, so its compose service disables this inherited
# healthcheck. Uses Node's global fetch — no curl in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# `node node_modules/@codesentra/db/dist/migrate-cli.js` applies migrations (pre-deploy).
CMD ["node", "--enable-source-maps", "dist/entry.js"]
