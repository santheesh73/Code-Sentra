import type { MembershipRole } from "@codesentra/core";
import { type Database, schema as s } from "@codesentra/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { UserRow } from "./auth/service.js";
import { forbidden, notFound, unauthorized } from "./errors.js";

const RANK: Record<MembershipRole, number> = { member: 1, admin: 2, owner: 3 };

export interface OrgAccess {
  user: UserRow;
  orgId: string;
  role: MembershipRole;
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Account-level actions (tokens, sign-out) need a signed-in session, not an API token. */
export function requireSessionUser(req: FastifyRequest): UserRow {
  const user = requireUser(req);
  if (req.tokenOrgId) throw forbidden("This action needs a signed-in session, not an API token");
  return user;
}

export function createAuthz(db: Database) {
  async function roleIn(userId: string, orgId: string): Promise<MembershipRole | null> {
    const [m] = await db.system
      .select({ role: s.memberships.role })
      .from(s.memberships)
      .where(and(eq(s.memberships.userId, userId), eq(s.memberships.orgId, orgId)));
    return m?.role ?? null;
  }

  /**
   * Resolves the caller's access to an org. Non-members get 404 (the org's existence is
   * not revealed); members below `minRole` get 403.
   */
  async function requireOrg(
    req: FastifyRequest,
    orgId: string,
    minRole: MembershipRole = "member",
    what = "Organization",
  ): Promise<OrgAccess> {
    const user = requireUser(req);
    // An API token reaches only its own org; anything else looks absent.
    if (req.tokenOrgId && req.tokenOrgId !== orgId) throw notFound(what);
    const role = await roleIn(user.id, orgId);
    if (!role) throw notFound(what);
    if (RANK[role] < RANK[minRole]) throw forbidden();
    return { user, orgId, role };
  }

  async function orgOf(
    table: typeof s.projects | typeof s.runs | typeof s.issues | typeof s.evidence,
    id: string,
  ): Promise<string | null> {
    const [row] = await db.system
      .select({ orgId: table.orgId })
      .from(table)
      .where(eq(table.id, id));
    return row?.orgId ?? null;
  }

  return {
    roleIn,
    requireOrg,
    async requireProject(
      req: FastifyRequest,
      projectId: string,
      minRole: MembershipRole = "member",
    ) {
      requireUser(req);
      const orgId = await orgOf(s.projects, projectId);
      if (!orgId) throw notFound("Project");
      return requireOrg(req, orgId, minRole, "Project");
    },
    async requireIssue(req: FastifyRequest, issueId: string) {
      requireUser(req);
      const orgId = await orgOf(s.issues, issueId);
      if (!orgId) throw notFound("Issue");
      return requireOrg(req, orgId, "member", "Issue");
    },
    async requireEvidence(req: FastifyRequest, evidenceId: string) {
      requireUser(req);
      const orgId = await orgOf(s.evidence, evidenceId);
      if (!orgId) throw notFound("Evidence");
      return requireOrg(req, orgId, "member", "Evidence");
    },
    async requireRun(req: FastifyRequest, runId: string) {
      requireUser(req);
      const orgId = await orgOf(s.runs, runId);
      if (!orgId) throw notFound("Run");
      return requireOrg(req, orgId, "member", "Run");
    },
  };
}

export type Authz = ReturnType<typeof createAuthz>;
