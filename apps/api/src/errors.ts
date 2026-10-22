import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { z } from "zod";

/** RFC 9457 problem details. */
export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: "Problem" });
export type Problem = z.infer<typeof Problem>;

const TYPE_BASE = "https://codesentra.dev/problems/";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
  }
}

/** Section 17 run limits; Retry-After says when the window has room again. */
export const tooManyRuns = (detail: string, retryAfterSeconds: number) =>
  new HttpError(429, "rate-limited", "Too many requests", detail, {
    "retry-after": String(retryAfterSeconds),
  });

export const notFound = (what = "Resource", detail?: string) =>
  new HttpError(404, "not-found", "Not found", detail ?? `${what} not found`);
export const unauthorized = () =>
  new HttpError(401, "unauthorized", "Authentication required", "Sign in to continue");
export const forbidden = (detail = "Your role does not allow this action") =>
  new HttpError(403, "forbidden", "Forbidden", detail);
export const badRequest = (detail: string) =>
  new HttpError(400, "bad-request", "Bad request", detail);
export const conflict = (detail: string) => new HttpError(409, "conflict", "Conflict", detail);
/** Rule 6: unbuilt features say so; they never return canned data. */
export const notImplemented = (feature: string, phase: string) =>
  new HttpError(
    501,
    "not-implemented",
    "Not yet available",
    `${feature} is not available yet (planned for ${phase}).`,
  );
export const notConfigured = (feature: string, vars: string) =>
  new HttpError(
    501,
    "not-configured",
    "Not configured",
    `${feature} is not configured on this server (set ${vars}).`,
  );

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type("application/problem+json").send(p);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return sendProblem(reply, {
        type: TYPE_BASE + err.slug,
        title: err.title,
        status: err.status,
        detail: err.detail,
        instance: req.url,
      });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return sendProblem(reply, {
        type: `${TYPE_BASE}validation`,
        title: "Invalid request",
        status: 400,
        detail: "The request did not match the schema",
        instance: req.url,
        errors: err.validation.map((v) => ({
          path: `${err.validationContext ?? "body"}${v.instancePath || ""}`,
          message: v.message ?? "invalid",
        })),
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, "response did not match its schema");
      return sendProblem(reply, {
        type: `${TYPE_BASE}internal`,
        title: "Internal error",
        status: 500,
        instance: req.url,
      });
    }
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return sendProblem(reply, {
      type:
        TYPE_BASE + (status === 429 ? "rate-limited" : status >= 500 ? "internal" : "bad-request"),
      title:
        status === 429 ? "Too many requests" : status >= 500 ? "Internal error" : "Bad request",
      status,
      // Never leak internals on 5xx.
      detail: status >= 500 ? undefined : err.message,
      instance: req.url,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, {
      type: `${TYPE_BASE}not-found`,
      title: "Not found",
      status: 404,
      detail: `No route for ${req.method} ${req.url.split("?")[0]}`,
      instance: req.url,
    }),
  );
}
