# The web app as a container, for docker-compose and self-hosting. Production runs it on
# Vercel (apps/web/vercel.json); this image is the same build served by `next start`.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# Workspace packages that are only devDependencies, present so links resolve.
COPY apps/cli/package.json ./apps/cli/package.json
COPY fixtures/harness/package.json ./fixtures/harness/package.json
COPY fixtures/apps ./fixtures/apps
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter "@codesentra/web..." \
 && pnpm --filter "@codesentra/web..." --filter "!@codesentra/fixture-harness" \
      --filter "!@codesentra/cli" --filter "!@fixtures/*" run build \
 && pnpm deploy --filter @codesentra/web --prod --legacy /out \
 && cp -r apps/web/.next /out/.next \
 && rm -rf /out/.next/cache

FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]
