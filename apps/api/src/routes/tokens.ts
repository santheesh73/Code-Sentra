import { schema as s } from "@codesentra/db";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { API_TOKEN_PREFIX } from "../auth/service.js";
import { newToken, sha256 } from "../auth/tokens.js";
import { requireSessionUser } from "../authz.js";
import type { AppContext } from "../context.js";
import { badRequest, notFound, Problem } from "../errors.js";

const MAX_TOKENS_PER_USER = 20;

export const ApiTokenDto = z
  .object({
    id: z.uuid(),
    org_id: z.uuid(),
    name: z.string(),
    prefix: z.string().describe("The first characters of the token"),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime().nullable(),
    last_used_at: z.iso.datetime().nullable(),
  })
  .meta({ id: "ApiToken" });

type Row = typeof s.apiTokens.$inferSelect;
const dto = (r: Row): z.infer<typeof ApiTokenDto> => ({
  id: r.id,
  org_id: r.orgId,
  name: r.name,
  prefix: r.prefix,
  created_at: r.createdAt.toISOString(),
  expires_at: r.expiresAt?.toISOString() ?? null,
  last_used_at: r.lastUsedAt?.toISOString() ?? null,
});

const AuditEntryDto = z
  .object({
    id: z.uuid(),
    actor_id: z.uuid().nullable(),
    action: z.string(),
    target: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.iso.datetime(),
  })
  .meta({ id: "AuditEntry" });

/**
 * API tokens for the CLI and scripts (Section 15 `codesentra login`). A token acts as its
 * user within one org only; only its sha256 is stored; creation and revocation are
 * audited (Section 17). Managing tokens needs a signed-in session, not a token.
 */
export function tokenRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/orgs/:id/tokens",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          tags: ["tokens"],
          summary: "Create an API token",
          description:
            "The token is returned once and never again. Send it as `Authorization: Bearer <token>`. It can act only in this organization, with your role in it.",
          params: z.object({ id: z.uuid() }),
          body: z.object({
            name: z.string().trim().min(1).max(100),
            expires_in_days: z.number().int().min(1).max(365).nullable().default(90),
          }),
          response: {
            201: ApiTokenDto.extend({ token: z.string() }),
            400: Problem,
            401: Problem,
            403: Problem,
            404: Problem,
          },
        },
      },
      async (req, reply) => {
        requireSessionUser(req);
        const access = await ctx.authz.requireOrg(req, req.params.id);
        const token = `${API_TOKEN_PREFIX}${newToken()}`;
        const row = await ctx.db.withOrg(access.orgId, async (tx) => {
          const live = await tx
            .select({ id: s.apiTokens.id })
            .from(s.apiTokens)
            .where(and(eq(s.apiTokens.userId, access.user.id), isNull(s.apiTokens.revokedAt)));
          if (live.length >= MAX_TOKENS_PER_USER)
            throw badRequest(
              `You can have at most ${MAX_TOKENS_PER_USER} tokens in an organization`,
            );
          const days = req.body.expires_in_days;
          const [row] = await tx
            .insert(s.apiTokens)
            .values({
              orgId: access.orgId,
              userId: access.user.id,
              name: req.body.name,
              tokenHash: sha256(token),
              prefix: token.slice(0, 10),
              expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
            })
            .returning();
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "api_token.created",
            target: `api_token:${row?.id}`,
            metadata: { name: req.body.name, expires_in_days: days },
          });
          return row as Row;
        });
        return reply.code(201).send({ ...dto(row), token });
      },
    );

    app.get(
      "/v1/orgs/:id/tokens",
      {
        schema: {
          tags: ["tokens"],
          summary: "Your API tokens in this organization",
          params: z.object({ id: z.uuid() }),
          response: { 200: z.array(ApiTokenDto), 401: Problem, 403: Problem, 404: Problem },
        },
      },
      async (req) => {
        requireSessionUser(req);
        const access = await ctx.authz.requireOrg(req, req.params.id);
        const rows = await ctx.db.withOrg(access.orgId, (tx) =>
          tx
            .select()
            .from(s.apiTokens)
            .where(and(eq(s.apiTokens.userId, access.user.id), isNull(s.apiTokens.revokedAt)))
            .orderBy(desc(s.apiTokens.createdAt)),
        );
        return rows.map(dto);
      },
    );

    app.delete(
      "/v1/orgs/:id/tokens/:tokenId",
      {
        schema: {
          tags: ["tokens"],
          summary: "Revoke an API token",
          description: "Your own tokens; org admins can revoke anyone's.",
          params: z.object({ id: z.uuid(), tokenId: z.uuid() }),
          response: { 204: z.null(), 401: Problem, 403: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        requireSessionUser(req);
        const access = await ctx.authz.requireOrg(req, req.params.id);
        const admin = access.role === "admin" || access.role === "owner";
        await ctx.db.withOrg(access.orgId, async (tx) => {
          const revoked = await tx
            .update(s.apiTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(s.apiTokens.id, req.params.tokenId),
                isNull(s.apiTokens.revokedAt),
                ...(admin ? [] : [eq(s.apiTokens.userId, access.user.id)]),
              ),
            )
            .returning({ id: s.apiTokens.id });
          if (revoked.length === 0) throw notFound("API token");
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "api_token.revoked",
            target: `api_token:${req.params.tokenId}`,
          });
        });
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/v1/orgs/:id/audit",
      {
        schema: {
          tags: ["orgs"],
          summary: "Audit log (admins)",
          description:
            "Membership changes, project deletion, dismissals, token creation and revocation, schedules, notification channels and GitHub links, newest first.",
          params: z.object({ id: z.uuid() }),
          querystring: z.object({
            before: z.iso.datetime().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: z.array(AuditEntryDto), 401: Problem, 403: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireOrg(req, req.params.id, "admin");
        const rows = await ctx.db.withOrg(access.orgId, (tx) =>
          tx
            .select()
            .from(s.auditLog)
            .where(
              req.query.before ? lt(s.auditLog.createdAt, new Date(req.query.before)) : undefined,
            )
            .orderBy(desc(s.auditLog.createdAt))
            .limit(req.query.limit),
        );
        return rows.map((r) => ({
          id: r.id,
          actor_id: r.actorId,
          action: r.action,
          target: r.target,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
          created_at: r.createdAt.toISOString(),
        }));
      },
    );
  };
}
