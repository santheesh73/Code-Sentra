import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { newToken, pkceChallenge, safeNextPath, sign, verify } from "../auth/tokens.js";
import type { AppContext } from "../context.js";
import { MeDto, UserDto, userDto } from "../dto.js";
import { badRequest, HttpError, notConfigured, Problem } from "../errors.js";
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "../session-plugin.js";
import { listMyOrgs } from "./orgs.js";

const OAUTH_COOKIE = "cs_oauth";
const OAUTH_TTL_MS = 10 * 60 * 1000;

interface OAuthState {
  state: string;
  verifier: string;
  next: string;
  exp: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function authRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const appUrl = ctx.config.PUBLIC_APP_URL.replace(/\/$/, "");

    app.get(
      "/v1/auth/providers",
      {
        schema: {
          tags: ["auth"],
          summary: "Which sign-in methods this server has configured",
          response: { 200: z.object({ email: z.boolean(), github: z.boolean() }) },
        },
      },
      async () => ({ email: ctx.email !== null, github: ctx.config.integrations.github_oauth }),
    );

    app.post(
      "/v1/auth/email",
      {
        config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
        schema: {
          tags: ["auth"],
          summary: "Send a sign-in link by email",
          description:
            "Always answers 202, whether or not the address has an account, so the endpoint cannot be used to discover users.",
          body: z.object({ email: z.email().max(320) }),
          response: { 202: z.object({ sent: z.literal(true) }), 501: Problem },
        },
      },
      async (req, reply) => {
        if (!ctx.email)
          throw notConfigured(
            "Email sign-in",
            "EMAIL_FROM and EMAIL_PROVIDER_API_KEY, or EMAIL_TRANSPORT=outbox outside production",
          );
        const token = await ctx.auth.issueMagicLink(req.body.email);
        if (token) {
          // The token travels in the fragment: never sent to a server, never in access logs.
          const link = `${appUrl}/auth/verify#token=${token}`;
          await ctx.email.send({
            to: req.body.email,
            subject: "Your CodeSentra sign-in link",
            text: `Sign in to CodeSentra:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
            html: `<p>Sign in to CodeSentra:</p><p><a href="${escapeHtml(link)}">Sign in</a></p><p>This link works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
          });
        } else {
          req.log.warn("magic link rate limit reached for an address");
        }
        return reply.code(202).send({ sent: true });
      },
    );

    app.post(
      "/v1/auth/email/verify",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: {
          tags: ["auth"],
          summary: "Exchange a sign-in link token for a session",
          body: z.object({ token: z.string().min(20).max(200) }),
          response: { 200: z.object({ user: UserDto }), 400: Problem },
        },
      },
      async (req, reply) => {
        const email = await ctx.auth.consumeMagicLink(req.body.token);
        if (!email) throw badRequest("This sign-in link is invalid, expired or already used");
        const { user } = await ctx.auth.upsertUser(email);
        const session = await ctx.auth.createSession(user.id);
        setSessionCookie(reply, session.token, session.expiresAt, ctx.cookie);
        return { user: userDto(user) };
      },
    );

    app.get(
      "/v1/auth/github",
      {
        schema: {
          tags: ["auth"],
          summary: "Start GitHub sign-in",
          querystring: z.object({ next: z.string().max(512).optional() }),
          response: { 302: z.null(), 501: Problem },
        },
      },
      async (req, reply) => {
        if (!ctx.config.integrations.github_oauth || !ctx.config.GITHUB_OAUTH_CLIENT_ID) {
          throw notConfigured(
            "GitHub sign-in",
            "GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET",
          );
        }
        const st: OAuthState = {
          state: newToken(),
          verifier: newToken(),
          next: safeNextPath(req.query.next),
          exp: Date.now() + OAUTH_TTL_MS,
        };
        reply.setCookie(OAUTH_COOKIE, sign(st, ctx.config.SESSION_SECRET), {
          httpOnly: true,
          secure: ctx.cookie.secure,
          sameSite: "lax",
          path: "/",
          maxAge: OAUTH_TTL_MS / 1000,
        });
        const u = new URL("/login/oauth/authorize", ctx.config.GITHUB_OAUTH_BASE_URL);
        u.searchParams.set("client_id", ctx.config.GITHUB_OAUTH_CLIENT_ID);
        u.searchParams.set("redirect_uri", `${appUrl}/api/v1/auth/github/callback`);
        u.searchParams.set("scope", "read:user user:email");
        u.searchParams.set("state", st.state);
        u.searchParams.set("code_challenge", pkceChallenge(st.verifier));
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("allow_signup", "true");
        return reply.redirect(u.toString(), 302);
      },
    );

    app.get(
      "/v1/auth/github/callback",
      {
        schema: {
          tags: ["auth"],
          summary: "GitHub OAuth callback",
          querystring: z.object({
            code: z.string().max(512).optional(),
            state: z.string().max(512).optional(),
            error: z.string().max(200).optional(),
          }),
          response: { 302: z.null(), 501: Problem },
        },
      },
      async (req, reply) => {
        const fail = (code: string) => {
          reply.clearCookie(OAUTH_COOKIE, { path: "/" });
          return reply.redirect(`${appUrl}/signin?error=${encodeURIComponent(code)}`, 302);
        };
        if (!ctx.config.integrations.github_oauth) {
          throw notConfigured(
            "GitHub sign-in",
            "GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET",
          );
        }
        const st = verify<OAuthState>(req.cookies[OAUTH_COOKIE], ctx.config.SESSION_SECRET);
        if (req.query.error) return fail("github_denied");
        if (
          !st ||
          st.exp < Date.now() ||
          !req.query.state ||
          st.state !== req.query.state ||
          !req.query.code
        ) {
          return fail("github_state");
        }
        try {
          const gh = await exchangeGithubCode(
            ctx,
            req.query.code,
            st.verifier,
            `${appUrl}/api/v1/auth/github/callback`,
          );
          if (!gh.verifiedEmail) return fail("github_no_verified_email");
          const user = await ctx.auth.signInWithGithub({ ...gh, verifiedEmail: gh.verifiedEmail });
          const session = await ctx.auth.createSession(user.id);
          setSessionCookie(reply, session.token, session.expiresAt, ctx.cookie);
          reply.clearCookie(OAUTH_COOKIE, { path: "/" });
          return reply.redirect(`${appUrl}${st.next}`, 302);
        } catch (e) {
          req.log.error({ err: (e as Error).message }, "github oauth failed");
          return fail("github_failed");
        }
      },
    );

    app.post(
      "/v1/auth/logout",
      { schema: { tags: ["auth"], summary: "End the session", response: { 204: z.null() } } },
      async (req, reply) => {
        const token = req.cookies[SESSION_COOKIE];
        if (token) await ctx.auth.deleteSession(token);
        clearSessionCookie(reply, ctx.cookie);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/v1/me",
      {
        schema: {
          tags: ["auth"],
          summary: "The signed-in user and their organizations",
          response: { 200: MeDto, 401: Problem },
        },
      },
      async (req) => {
        if (!req.user)
          throw new HttpError(
            401,
            "unauthorized",
            "Authentication required",
            "Sign in to continue",
          );
        return { user: userDto(req.user), organizations: await listMyOrgs(ctx, req.user.id) };
      },
    );
  };
}

const GithubToken = z.object({ access_token: z.string().min(1) });
const GithubUser = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
});
const GithubEmails = z.array(
  z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
);

async function exchangeGithubCode(
  ctx: AppContext,
  code: string,
  verifier: string,
  redirectUri: string,
) {
  const timeout = () => AbortSignal.timeout(10_000);
  const tokenRes = await ctx.fetch(
    new URL("/login/oauth/access_token", ctx.config.GITHUB_OAUTH_BASE_URL),
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: ctx.config.GITHUB_OAUTH_CLIENT_ID,
        client_secret: ctx.config.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      signal: timeout(),
    },
  );
  if (!tokenRes.ok) throw new Error(`token exchange returned ${tokenRes.status}`);
  const { access_token } = GithubToken.parse(await tokenRes.json());
  const api = (path: string) =>
    ctx.fetch(new URL(path, ctx.config.GITHUB_API_BASE_URL), {
      headers: {
        authorization: `Bearer ${access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "CodeSentra",
      },
      signal: timeout(),
    });
  const [userRes, emailsRes] = await Promise.all([api("/user"), api("/user/emails")]);
  if (!userRes.ok) throw new Error(`/user returned ${userRes.status}`);
  if (!emailsRes.ok) throw new Error(`/user/emails returned ${emailsRes.status}`);
  const user = GithubUser.parse(await userRes.json());
  const emails = GithubEmails.parse(await emailsRes.json());
  const primary = emails.find((e) => e.primary && e.verified) ?? null;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    verifiedEmail: primary?.email ?? null,
  };
}
