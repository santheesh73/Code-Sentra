import { randomBytes } from "node:crypto";
import { MembershipRole } from "@codesentra/core";
import { schema as s } from "@codesentra/db";
import { and, asc, count, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { normalizeEmail } from "../auth/service.js";
import { requireUser } from "../authz.js";
import type { AppContext } from "../context.js";
import { MemberDto, OrgDto, userDto } from "../dto.js";
import { badRequest, conflict, forbidden, notFound, Problem } from "../errors.js";

export async function listMyOrgs(ctx: AppContext, userId: string) {
  const rows = await ctx.db.system
    .select({ org: s.organizations, role: s.memberships.role })
    .from(s.memberships)
    .innerJoin(s.organizations, eq(s.organizations.id, s.memberships.orgId))
    .where(eq(s.memberships.userId, userId))
    .orderBy(asc(s.organizations.createdAt));
  return rows.map((r) => ({ id: r.org.id, name: r.org.name, slug: r.org.slug, role: r.role }));
}

const OrgParams = z.object({ orgId: z.uuid() });
const MemberParams = OrgParams.extend({ userId: z.uuid() });

export function orgRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/v1/orgs",
      {
        schema: {
          tags: ["orgs"],
          summary: "Organizations you belong to",
          response: { 200: z.array(OrgDto), 401: Problem },
        },
      },
      async (req) => listMyOrgs(ctx, requireUser(req).id),
    );

    app.post(
      "/v1/orgs",
      {
        schema: {
          tags: ["orgs"],
          summary: "Create an organization (you become its owner)",
          body: z.object({ name: z.string().trim().min(1).max(100) }),
          response: { 201: OrgDto, 401: Problem },
        },
      },
      async (req, reply) => {
        const user = requireUser(req);
        const slugBase =
          req.body.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "org";
        const org = await ctx.db.system.transaction(async (tx) => {
          const [o] = await tx
            .insert(s.organizations)
            .values({ name: req.body.name, slug: `${slugBase}-${randomBytes(3).toString("hex")}` })
            .returning();
          if (!o) throw new Error("org insert failed");
          await tx.insert(s.memberships).values({ orgId: o.id, userId: user.id, role: "owner" });
          await tx.insert(s.auditLog).values({
            orgId: o.id,
            actorId: user.id,
            action: "organization.created",
            target: `organization:${o.id}`,
          });
          return o;
        });
        return reply
          .code(201)
          .send({ id: org.id, name: org.name, slug: org.slug, role: "owner" as const });
      },
    );

    app.get(
      "/v1/orgs/:orgId/members",
      {
        schema: {
          tags: ["orgs"],
          summary: "Members of an organization",
          params: OrgParams,
          response: { 200: z.array(MemberDto), 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const { orgId } = await ctx.authz.requireOrg(req, req.params.orgId);
        const rows = await ctx.db.withOrg(orgId, (tx) =>
          tx
            .select({
              m: s.memberships,
              u: {
                id: s.users.id,
                email: s.users.email,
                name: s.users.name,
                avatarUrl: s.users.avatarUrl,
              },
            })
            .from(s.memberships)
            .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
            .orderBy(asc(s.memberships.createdAt)),
        );
        return rows.map((r) => ({
          user: userDto(r.u),
          role: r.m.role,
          joined_at: r.m.createdAt.toISOString(),
        }));
      },
    );

    app.post(
      "/v1/orgs/:orgId/members",
      {
        schema: {
          tags: ["orgs"],
          summary: "Add a member by email (admin or owner)",
          description:
            "Creates the user if they have never signed in; they join on their first sign-in with that address.",
          params: OrgParams,
          body: z.object({ email: z.email().max(320), role: MembershipRole.default("member") }),
          response: { 201: MemberDto, 401: Problem, 403: Problem, 404: Problem, 409: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireOrg(req, req.params.orgId, "admin");
        if (req.body.role === "owner" && access.role !== "owner")
          throw forbidden("Only owners can add owners");
        const email = normalizeEmail(req.body.email);
        const member = await ctx.db.system.transaction(async (tx) => {
          await tx.insert(s.users).values({ email }).onConflictDoNothing({ target: s.users.email });
          const [u] = await tx.select().from(s.users).where(eq(s.users.email, email));
          if (!u) throw new Error("user upsert failed");
          const inserted = await tx
            .insert(s.memberships)
            .values({ orgId: access.orgId, userId: u.id, role: req.body.role })
            .onConflictDoNothing()
            .returning();
          if (inserted.length === 0) throw conflict("That person is already a member");
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "membership.added",
            target: `user:${u.id}`,
            metadata: { role: req.body.role },
          });
          const m = inserted[0];
          if (!m) throw new Error("membership insert returned no row");
          return { u, m };
        });
        return reply.code(201).send({
          user: userDto(member.u),
          role: member.m.role,
          joined_at: member.m.createdAt.toISOString(),
        });
      },
    );

    app.patch(
      "/v1/orgs/:orgId/members/:userId",
      {
        schema: {
          tags: ["orgs"],
          summary: "Change a member's role (owner)",
          params: MemberParams,
          body: z.object({ role: MembershipRole }),
          response: { 200: MemberDto, 400: Problem, 401: Problem, 403: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireOrg(req, req.params.orgId, "owner");
        return ctx.db.system.transaction(async (tx) => {
          const [m] = await tx
            .select()
            .from(s.memberships)
            .where(
              and(
                eq(s.memberships.orgId, access.orgId),
                eq(s.memberships.userId, req.params.userId),
              ),
            )
            .for("update");
          if (!m) throw notFound("Member");
          if (m.role === "owner" && req.body.role !== "owner")
            await assertAnotherOwner(tx, access.orgId);
          const [updated] = await tx
            .update(s.memberships)
            .set({ role: req.body.role })
            .where(eq(s.memberships.id, m.id))
            .returning();
          const [u] = await tx.select().from(s.users).where(eq(s.users.id, m.userId));
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "membership.role_changed",
            target: `user:${m.userId}`,
            metadata: { from: m.role, to: req.body.role },
          });
          if (!u || !updated) throw new Error("membership update returned no row");
          return {
            user: userDto(u),
            role: updated.role,
            joined_at: updated.createdAt.toISOString(),
          };
        });
      },
    );

    app.delete(
      "/v1/orgs/:orgId/members/:userId",
      {
        schema: {
          tags: ["orgs"],
          summary: "Remove a member (admin or owner; anyone may remove themselves)",
          params: MemberParams,
          response: { 204: z.null(), 400: Problem, 401: Problem, 403: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const self = requireUser(req).id === req.params.userId;
        const access = await ctx.authz.requireOrg(req, req.params.orgId, self ? "member" : "admin");
        await ctx.db.system.transaction(async (tx) => {
          const [m] = await tx
            .select()
            .from(s.memberships)
            .where(
              and(
                eq(s.memberships.orgId, access.orgId),
                eq(s.memberships.userId, req.params.userId),
              ),
            )
            .for("update");
          if (!m) throw notFound("Member");
          if (m.role === "owner") {
            if (access.role !== "owner") throw forbidden("Only owners can remove owners");
            await assertAnotherOwner(tx, access.orgId);
          }
          await tx.delete(s.memberships).where(eq(s.memberships.id, m.id));
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "membership.removed",
            target: `user:${m.userId}`,
            metadata: { role: m.role },
          });
        });
        return reply.code(204).send(null);
      },
    );
  };
}

type Tx = Parameters<Parameters<AppContext["db"]["system"]["transaction"]>[0]>[0];

async function assertAnotherOwner(tx: Tx, orgId: string): Promise<void> {
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(s.memberships)
    .where(and(eq(s.memberships.orgId, orgId), eq(s.memberships.role, "owner")));
  if (n <= 1) throw badRequest("An organization must keep at least one owner");
}
