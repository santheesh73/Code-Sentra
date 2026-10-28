import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService, UserRow } from "./auth/service.js";
import { HttpError } from "./errors.js";

export const SESSION_COOKIE = "cs_session";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow | null;
    /** Set when the request authenticated with an API token: the only org it may act in. */
    tokenOrgId: string | null;
  }
}

export interface CookieSettings {
  secure: boolean;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  c: CookieSettings,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.secure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, c: CookieSettings) {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: c.secure,
    sameSite: "lax",
    path: "/",
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolves the session cookie to `request.user`, and enforces an Origin check on
 * state-changing requests (CSRF defence alongside SameSite=Lax and JSON-only bodies).
 */
export function registerSession(
  app: FastifyInstance,
  auth: AuthService,
  opts: { appOrigin: string; cookie: CookieSettings; exemptPrefixes: string[] },
): void {
  app.decorateRequest("user", null);
  app.decorateRequest("tokenOrgId", null);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] ?? "";
    // API tokens (CLI): no ambient credential, so no CSRF check; cookies are ignored.
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (bearer && !opts.exemptPrefixes.some((p) => path.startsWith(p))) {
      const found = await auth.lookupApiToken(bearer);
      if (!found)
        throw new HttpError(
          401,
          "unauthorized",
          "Authentication required",
          "The API token is invalid, expired or revoked",
        );
      req.user = found.user;
      req.tokenOrgId = found.orgId;
      return;
    }
    if (!SAFE_METHODS.has(req.method) && !opts.exemptPrefixes.some((p) => path.startsWith(p))) {
      const origin = req.headers.origin;
      const referer = req.headers.referer;
      const source = origin ?? (referer ? safeOrigin(referer) : undefined);
      if (source !== opts.appOrigin) {
        throw new HttpError(
          403,
          "bad-origin",
          "Cross-origin request refused",
          "State-changing requests must come from the CodeSentra app",
        );
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const found = await auth.lookupSession(token);
    if (!found) {
      clearSessionCookie(reply, opts.cookie);
      return;
    }
    req.user = found.user;
    if (found.renewedUntil) setSessionCookie(reply, token, found.renewedUntil, opts.cookie);
  });
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
