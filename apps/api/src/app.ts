import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import type { FastifyBaseLogger } from "fastify";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { AppContext } from "./context.js";
import { registerErrorHandling } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { issueRoutes } from "./routes/issues.js";
import { orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";
import { pulseRoutes } from "./routes/pulse.js";
import { runRoutes } from "./routes/runs.js";
import { unbuiltRoutes } from "./routes/unbuilt.js";
import { registerSession } from "./session-plugin.js";

export interface RegisteredRoute {
  method: string;
  url: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  routes: RegisteredRoute[];
}

export const API_VERSION = "0.1.0";

export async function buildApp(
  ctx: AppContext,
  opts: { logger?: FastifyBaseLogger; trustProxy?: boolean } = {},
): Promise<BuiltApp> {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    trustProxy: opts.trustProxy ?? true,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (r) => {
    if (r.url.startsWith("/v1/") || r.url === "/health") {
      for (const m of [r.method].flat()) if (m !== "HEAD") routes.push({ method: m, url: r.url });
    }
  });

  registerErrorHandling(app);
  // Only JSON bodies are accepted, which (with SameSite=Lax and the Origin check) blocks
  // form-based CSRF: browsers cannot send application/json cross-site without CORS.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error("Body is not valid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "CodeSentra API",
        version: API_VERSION,
        description:
          "Errors are RFC 9457 problem+json. Long operations return 202 with a run id. Endpoints for later phases answer 501.",
      },
      components: {
        securitySchemes: { session: { type: "apiKey", in: "cookie", name: "cs_session" } },
      },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });

  registerSession(app, ctx.auth, {
    appOrigin: new URL(ctx.config.PUBLIC_APP_URL).origin,
    cookie: ctx.cookie,
    exemptPrefixes: ["/v1/webhooks/"],
  });

  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(orgRoutes(ctx));
  await app.register(projectRoutes(ctx));
  await app.register(runRoutes(ctx));
  await app.register(pulseRoutes(ctx));
  await app.register(issueRoutes(ctx));
  await app.register(unbuiltRoutes(ctx));

  app.get("/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await app.ready();
  return { app, routes };
}
