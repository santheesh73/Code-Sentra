# Fixture harness image: builds the fixture apps and serves them plus the failure simulators.
FROM node:22.23.4-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY fixtures/apps ./fixtures/apps
COPY fixtures/harness ./fixtures/harness
# Optional build secret `extra_ca`: a CA bundle for networks with a TLS-intercepting proxy.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter @codesentra/fixture-harness... \
 && pnpm turbo run build --filter @codesentra/fixture-harness... \
 && pnpm deploy --filter @codesentra/fixture-harness --prod --legacy /out \
 && cp -r fixtures/harness/dist /out/dist \
 && mkdir -p /out/fixtures \
 && cp -r fixtures/apps /out/fixtures/apps \
 && find /out/fixtures/apps -mindepth 2 -maxdepth 2 \( -name node_modules -o -name .next \) -exec rm -rf {} +

FROM node:22.23.4-bookworm-slim
WORKDIR /app/harness
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./package.json
# manifest.ts resolves ../../apps relative to dist/, i.e. /app/apps.
COPY --from=build /out/fixtures/apps /app/apps
USER node
EXPOSE 4100-4130
CMD ["node", "dist/cli.js"]
