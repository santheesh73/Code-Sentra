# Sentra Pulse worker image: worker-pulse plus the Chromium build pinned by playwright-core.
FROM node:22.23.4-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker-pulse ./apps/worker-pulse
# Test-only workspace packages, present so `pnpm deploy` can resolve devDependency links.
COPY fixtures/harness/package.json ./fixtures/harness/package.json
COPY fixtures/apps ./fixtures/apps
# Optional build secret `extra_ca`: a CA bundle for networks with a TLS-intercepting proxy.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter @codesentra/worker-pulse... \
 && pnpm --filter "@codesentra/worker-pulse..." --filter "!@codesentra/fixture-harness" \
      --filter "!@fixtures/*" run build \
 && pnpm deploy --filter @codesentra/worker-pulse --prod --legacy /out

# Chromium and its system libraries at exactly the revision playwright-core 1.64.1 drives.
# Node is replaced with the repo's pinned version (.nvmrc) so the worker runs as tested.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./package.json
USER pwuser
CMD ["node", "dist/main.js"]
