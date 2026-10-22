import { randomBytes } from "node:crypto";
import { type Database, schema as s } from "@codesentra/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { newToken, sha256 } from "./tokens.js";

/** API tokens look like `cs_<43 base64url chars>`, so scanners can recognize them. */
export const API_TOKEN_PREFIX = "cs_";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** Per-address cap on magic links, stored in Postgres so it holds across API replicas. */
export const MAGIC_LINKS_PER_WINDOW = 5;
const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;

export type UserRow = typeof s.users.$inferSelect;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function slugBase(email: string): string {
  const local = email.split("@")[0] ?? "org";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "org").slice(0, 32);
}

export function createAuthService(db: Database, now: () => Date = () => new Date()) {
  const sys = db.system;

  /**
   * Finds or creates the user for a verified email. A first sign-in also creates a
   * personal organization so the user has somewhere to put projects.
   */
  async function upsertUser(
    rawEmail: string,
    profile: { name?: string | null; avatarUrl?: string | null } = {},
  ): Promise<{ user: UserRow; created: boolean }> {
    const email = normalizeEmail(rawEmail);
    return sys.transaction(async (tx) => {
      const inserted = await tx
        .insert(s.users)
        .values({ email, name: profile.name ?? null, avatarUrl: profile.avatarUrl ?? null })
        .onConflictDoNothing({ target: s.users.email })
        .returning();
      const created = inserted.length > 0;
      const [user] = created
        ? inserted
        : await tx.select().from(s.users).where(eq(s.users.email, email));
      if (!user) throw new Error("upsertUser: user vanished");
      if (!created && (profile.name || profile.avatarUrl) && (!user.name || !user.avatarUrl)) {
        await tx
          .update(s.users)
          .set({
            name: user.name ?? profile.name ?? null,
            avatarUrl: user.avatarUrl ?? profile.avatarUrl ?? null,
          })
          .where(eq(s.users.id, user.id));
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(s.memberships)
        .where(eq(s.memberships.userId, user.id));
      if (n === 0) {
        const display = profile.name || user.name || email.split("@")[0];
        const [org] = await tx
          .insert(s.organizations)
          .values({
            name: `${display}'s workspace`,
            slug: `${slugBase(email)}-${randomBytes(3).toString("hex")}`,
          })
          .returning();
        if (!org) throw new Error("upsertUser: org insert failed");
        await tx.insert(s.memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
        await tx.insert(s.auditLog).values({
          orgId: org.id,
          actorId: user.id,
          action: "organization.created",
          target: `organization:${org.id}`,
          metadata: { personal: true },
        });
      }
      return { user, created };
    });
  }

  return {
    upsertUser,

    async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
      const token = newToken();
      const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
      await sys.insert(s.sessions).values({ userId, tokenHash: sha256(token), expiresAt });
      return { token, expiresAt };
    },

    /** Returns the session's user, extending the session once half its lifetime has passed. */
    async lookupSession(
      token: string,
    ): Promise<{ user: UserRow; sessionId: string; renewedUntil?: Date } | null> {
      const [row] = await sys
        .select({ session: s.sessions, user: s.users })
        .from(s.sessions)
        .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
        .where(and(eq(s.sessions.tokenHash, sha256(token)), gt(s.sessions.expiresAt, now())));
      if (!row) return null;
      const remaining = row.session.expiresAt.getTime() - now().getTime();
      if (remaining < SESSION_TTL_MS / 2) {
        const renewedUntil = new Date(now().getTime() + SESSION_TTL_MS);
        await sys
          .update(s.sessions)
          .set({ expiresAt: renewedUntil, lastSeenAt: now() })
          .where(eq(s.sessions.id, row.session.id));
        return { user: row.user, sessionId: row.session.id, renewedUntil };
      }
      return { user: row.user, sessionId: row.session.id };
    },

    /**
     * Resolves a bearer API token to its user and the one org it is bound to. A token of
     * a user who left the org stops working: membership is checked on every request.
     */
    async lookupApiToken(token: string): Promise<{ user: UserRow; orgId: string } | null> {
      if (!token.startsWith(API_TOKEN_PREFIX)) return null;
      const [row] = await sys
        .select({ token: s.apiTokens, user: s.users })
        .from(s.apiTokens)
        .innerJoin(s.users, eq(s.users.id, s.apiTokens.userId))
        .innerJoin(
          s.memberships,
          and(
            eq(s.memberships.userId, s.apiTokens.userId),
            eq(s.memberships.orgId, s.apiTokens.orgId),
          ),
        )
        .where(
          and(
            eq(s.apiTokens.tokenHash, sha256(token)),
            isNull(s.apiTokens.revokedAt),
            sql`(${s.apiTokens.expiresAt} is null or ${s.apiTokens.expiresAt} > ${now()})`,
          ),
        );
      if (!row) return null;
      // Coarse last-used (once a minute) so every request is not a write.
      if (!row.token.lastUsedAt || now().getTime() - row.token.lastUsedAt.getTime() > 60_000)
        await sys
          .update(s.apiTokens)
          .set({ lastUsedAt: now() })
          .where(eq(s.apiTokens.id, row.token.id));
      return { user: row.user, orgId: row.token.orgId };
    },

    async deleteSession(token: string): Promise<void> {
      await sys.delete(s.sessions).where(eq(s.sessions.tokenHash, sha256(token)));
    },

    /** Issues a single-use link token, or null when the address hit its rate limit. */
    async issueMagicLink(rawEmail: string): Promise<string | null> {
      const email = normalizeEmail(rawEmail);
      const since = new Date(now().getTime() - MAGIC_LINK_WINDOW_MS);
      const [{ n } = { n: 0 }] = await sys
        .select({ n: count() })
        .from(s.magicLinkTokens)
        .where(and(eq(s.magicLinkTokens.email, email), gt(s.magicLinkTokens.createdAt, since)));
      if (n >= MAGIC_LINKS_PER_WINDOW) return null;
      const token = newToken();
      await sys.insert(s.magicLinkTokens).values({
        email,
        tokenHash: sha256(token),
        expiresAt: new Date(now().getTime() + MAGIC_LINK_TTL_MS),
      });
      return token;
    },

    /** Atomically consumes a valid, unexpired, unused token. Returns its email. */
    async consumeMagicLink(token: string): Promise<string | null> {
      const [row] = await sys
        .update(s.magicLinkTokens)
        .set({ consumedAt: now() })
        .where(
          and(
            eq(s.magicLinkTokens.tokenHash, sha256(token)),
            isNull(s.magicLinkTokens.consumedAt),
            gt(s.magicLinkTokens.expiresAt, now()),
          ),
        )
        .returning({ email: s.magicLinkTokens.email });
      return row?.email ?? null;
    },

    /**
     * Signs in a GitHub user. Links by GitHub id first, then by verified primary email.
     * Only a verified email may link to an existing account.
     */
    async signInWithGithub(gh: {
      id: number;
      login: string;
      name: string | null;
      avatarUrl: string | null;
      verifiedEmail: string;
    }): Promise<UserRow> {
      const providerUserId = String(gh.id);
      const [existing] = await sys
        .select({ user: s.users })
        .from(s.authIdentities)
        .innerJoin(s.users, eq(s.users.id, s.authIdentities.userId))
        .where(
          and(
            eq(s.authIdentities.provider, "github"),
            eq(s.authIdentities.providerUserId, providerUserId),
          ),
        );
      if (existing) {
        await sys
          .update(s.authIdentities)
          .set({ providerLogin: gh.login })
          .where(
            and(
              eq(s.authIdentities.provider, "github"),
              eq(s.authIdentities.providerUserId, providerUserId),
            ),
          );
        return existing.user;
      }
      const { user } = await upsertUser(gh.verifiedEmail, {
        name: gh.name,
        avatarUrl: gh.avatarUrl,
      });
      await sys
        .insert(s.authIdentities)
        .values({ userId: user.id, provider: "github", providerUserId, providerLogin: gh.login })
        .onConflictDoNothing();
      return user;
    },

    /** Deletes expired sessions and magic-link tokens. */
    async purgeExpired(): Promise<void> {
      await sys.delete(s.sessions).where(sql`${s.sessions.expiresAt} < ${now()}`);
      await sys
        .delete(s.magicLinkTokens)
        .where(
          sql`${s.magicLinkTokens.expiresAt} < ${new Date(now().getTime() - 24 * 3600 * 1000)}`,
        );
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
