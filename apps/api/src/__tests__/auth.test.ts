import { schema as s } from "@codesentra/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAGIC_LINKS_PER_WINDOW } from "../auth/service.js";
import { sha256 } from "../auth/tokens.js";
import { APP_URL, as, cookieFrom, ORIGIN, signIn, startTestApi, type TestApi } from "./helpers.js";

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
}, 180_000);
afterAll(async () => api?.close());

const tokenOf = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";

describe("health", () => {
  it("reports database and queue", async () => {
    const res = await api.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", queue: "ok" } });
  });
});

describe("providers", () => {
  it("reports only configured sign-in methods", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect(res.json()).toEqual({ email: true, github: true });
  });
});

describe("magic link sign-in", () => {
  it("signs in, creates a personal org, and exposes /v1/me", async () => {
    const cookie = await signIn(api, "Ana@Example.com");
    const me = await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.email).toBe("ana@example.com");
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0].role).toBe("owner");
  });

  it("puts the token in the URL fragment and stores only its hash", async () => {
    await api.app.inject({
      method: "POST",
      url: "/v1/auth/email",
      headers: ORIGIN,
      payload: { email: "hash@example.com" },
    });
    const msg = api.mail.sent.at(-1);
    expect(msg?.text).toContain(`${APP_URL}/auth/verify#token=`);
    const token = tokenOf(msg?.text ?? "");
    const rows = await api.t.db.system
      .select()
      .from(s.magicLinkTokens)
      .where(eq(s.magicLinkTokens.email, "hash@example.com"));
    expect(rows[0]?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("accepts each token once", async () => {
    await api.app.inject({
      method: "POST",
      url: "/v1/auth/email",
      headers: ORIGIN,
      payload: { email: "once@example.com" },
    });
    const token = tokenOf(api.mail.sent.at(-1)?.text ?? "");
    const first = await api.app.inject({
      method: "POST",
      url: "/v1/auth/email/verify",
      headers: ORIGIN,
      payload: { token },
    });
    expect(first.statusCode).toBe(200);
    const second = await api.app.inject({
      method: "POST",
      url: "/v1/auth/email/verify",
      headers: ORIGIN,
      payload: { token },
    });
    expect(second.statusCode).toBe(400);
    expect(second.headers["content-type"]).toContain("application/problem+json");
  });

  it("rejects an expired token", async () => {
    await api.app.inject({
      method: "POST",
      url: "/v1/auth/email",
      headers: ORIGIN,
      payload: { email: "late@example.com" },
    });
    const token = tokenOf(api.mail.sent.at(-1)?.text ?? "");
    await api.t.db.system
      .update(s.magicLinkTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.magicLinkTokens.tokenHash, sha256(token)));
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/auth/email/verify",
      headers: ORIGIN,
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
  });

  it("answers 202 identically when rate limited, without sending more mail", async () => {
    const email = "spam@example.com";
    const before = api.mail.sent.filter((m) => m.to === email).length;
    for (let i = 0; i < MAGIC_LINKS_PER_WINDOW + 3; i++) {
      const res = await api.app.inject({
        method: "POST",
        url: "/v1/auth/email",
        headers: ORIGIN,
        payload: { email },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ sent: true });
    }
    expect(api.mail.sent.filter((m) => m.to === email).length - before).toBe(
      MAGIC_LINKS_PER_WINDOW,
    );
  });

  it("validates input as problem+json", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/auth/email",
      headers: ORIGIN,
      payload: { email: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 400, title: "Invalid request" });
    expect(res.json().errors[0].path).toContain("email");
  });

  it("logout ends the session", async () => {
    const cookie = await signIn(api, "bye@example.com");
    const out = await api.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: as(cookie),
    });
    expect(out.statusCode).toBe(204);
    const me = await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it("never stores the session token itself", async () => {
    const cookie = await signIn(api, "tok@example.com");
    const token = cookie.split("=")[1] ?? "";
    const rows = await api.t.db.system.select().from(s.sessions);
    expect(rows.some((r) => r.tokenHash === sha256(token))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe("CSRF defences", () => {
  it("refuses state-changing requests without the app origin", async () => {
    const cookie = await signIn(api, "csrf@example.com");
    for (const headers of [
      { cookie },
      { cookie, origin: "https://evil.example" },
      { cookie, referer: "https://evil.example/x" },
    ]) {
      const res = await api.app.inject({
        method: "POST",
        url: "/v1/orgs",
        headers,
        payload: { name: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toMatch(/bad-origin/);
    }
    const ok = await api.app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: as(cookie),
      payload: { name: "x" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("accepts only JSON bodies", async () => {
    const cookie = await signIn(api, "form@example.com");
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: { ...as(cookie), "content-type": "application/x-www-form-urlencoded" },
      payload: "name=x",
    });
    expect(res.statusCode).toBe(415);
  });

  it("sets an HttpOnly, SameSite=Lax session cookie", async () => {
    await api.app.inject({
      method: "POST",
      url: "/v1/auth/email",
      headers: ORIGIN,
      payload: { email: "cookie@example.com" },
    });
    const token = tokenOf(api.mail.sent.at(-1)?.text ?? "");
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/auth/email/verify",
      headers: ORIGIN,
      payload: { token },
    });
    const c = res.cookies.find((x) => x.name === "cs_session");
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe("Lax");
    expect(c?.path).toBe("/");
  });
});

describe("GitHub OAuth", () => {
  async function begin(next?: string) {
    const res = await api.app.inject({
      method: "GET",
      url: `/v1/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`,
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    return { loc, stateCookie: cookieFrom(res, "cs_oauth") ?? "" };
  }

  async function finish(user: string, opts: { tamperState?: boolean } = {}) {
    const { loc, stateCookie } = await begin("/projects/abc");
    expect(loc.origin).toBe(api.github.url);
    expect(loc.pathname).toBe("/login/oauth/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${APP_URL}/api/v1/auth/github/callback`);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    const code = `code-${Math.random()}`;
    api.github.codes.set(code, {
      user,
      challenge: loc.searchParams.get("code_challenge") ?? undefined,
    });
    const state = opts.tamperState ? "forged" : (loc.searchParams.get("state") ?? "");
    return api.app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: `cs_oauth=${stateCookie}` },
    });
  }

  it("signs in with a verified primary email and redirects to the requested page", async () => {
    api.github.users.set("octo", {
      id: 4242,
      login: "octo",
      name: "Octo Cat",
      emails: [
        { email: "octo-secondary@example.com", primary: false, verified: true },
        { email: "octo@example.com", primary: true, verified: true },
      ],
    });
    const res = await finish("octo");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${APP_URL}/projects/abc`);
    const cookie = `cs_session=${cookieFrom(res)}`;
    const me = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json();
    expect(me.user).toMatchObject({ email: "octo@example.com", name: "Octo Cat" });
  });

  it("links GitHub to an existing magic-link account with the same verified email", async () => {
    const cookie = await signIn(api, "linked@example.com");
    const before = (
      await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })
    ).json();
    api.github.users.set("linked", {
      id: 777,
      login: "linked",
      name: null,
      emails: [{ email: "Linked@example.com", primary: true, verified: true }],
    });
    const res = await finish("linked");
    const after = (
      await api.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { cookie: `cs_session=${cookieFrom(res)}` },
      })
    ).json();
    expect(after.user.id).toBe(before.user.id);
    expect(after.organizations).toEqual(before.organizations);
  });

  it("refuses accounts without a verified primary email", async () => {
    api.github.users.set("unverified", {
      id: 5,
      login: "u",
      name: null,
      emails: [{ email: "u@example.com", primary: true, verified: false }],
    });
    const res = await finish("unverified");
    expect(res.headers.location).toBe(`${APP_URL}/signin?error=github_no_verified_email`);
    expect(cookieFrom(res)).toBeUndefined();
  });

  it("refuses a forged state", async () => {
    api.github.users.set("forge", {
      id: 6,
      login: "f",
      name: null,
      emails: [{ email: "f@example.com", primary: true, verified: true }],
    });
    const res = await finish("forge", { tamperState: true });
    expect(res.headers.location).toBe(`${APP_URL}/signin?error=github_state`);
  });

  it("ignores off-site post-login redirects", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      const { stateCookie } = await begin(next);
      const payload = JSON.parse(
        Buffer.from(stateCookie.split(".")[0] ?? "", "base64url").toString(),
      );
      expect(payload.next).toBe("/projects");
    }
  });
});
