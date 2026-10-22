import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "@codesentra/config";
import type { JobType } from "@codesentra/core";
import { startTestDatabase, type TestDatabase } from "@codesentra/db/testing";
import {
  createRunEventListener,
  diagnosticHandler,
  type JobHandler,
  type QueueClient,
  type RunEventListener,
  startQueueClient,
  startWorker,
  type Worker,
} from "@codesentra/queue";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp, type RegisteredRoute } from "../app.js";
import { createAuthService } from "../auth/service.js";
import { createAuthz } from "../authz.js";
import { memoryTransport } from "../email.js";

export const APP_URL = "http://localhost:3000";
export const ORIGIN = { origin: APP_URL };

export interface FakeGithub {
  url: string;
  users: Map<
    string,
    {
      id: number;
      login: string;
      name: string | null;
      emails: { email: string; primary: boolean; verified: boolean }[];
    }
  >;
  /** code → { user key, expected PKCE challenge } */
  codes: Map<string, { user: string; challenge?: string }>;
  close(): Promise<void>;
}

/** A local stand-in for github.com's OAuth + REST endpoints (no internet in tests). */
export async function startFakeGithub(): Promise<FakeGithub> {
  const users: FakeGithub["users"] = new Map();
  const codes: FakeGithub["codes"] = new Map();
  const tokens = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as {
          code: string;
          code_verifier?: string;
          client_secret?: string;
        };
        const entry = codes.get(body.code);
        if (!entry || body.client_secret !== "gh-client-secret-for-tests")
          return json(200, { error: "bad_verification_code" });
        if (entry.challenge) {
          const got = createHash("sha256")
            .update(body.code_verifier ?? "")
            .digest("base64url");
          if (got !== entry.challenge) return json(200, { error: "invalid_grant" });
        }
        codes.delete(body.code);
        const token = `gho_${Math.random().toString(36).slice(2)}`;
        tokens.set(token, entry.user);
        return json(200, {
          access_token: token,
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      });
      return;
    }
    const user = users.get(
      tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, "")) ?? "",
    );
    if (!user) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user")
      return json(200, { id: user.id, login: user.login, name: user.name, avatar_url: null });
    if (url.pathname === "/user/emails") return json(200, user.emails);
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    users,
    codes,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface TestApi {
  app: FastifyInstance;
  routes: RegisteredRoute[];
  t: TestDatabase;
  queue: QueueClient;
  events: RunEventListener;
  worker: Worker;
  mail: ReturnType<typeof memoryTransport>;
  github: FakeGithub;
  close(): Promise<void>;
}

export interface TestApiOptions {
  env?: Record<string, string>;
  handlers?: Partial<Record<JobType, JobHandler>>;
}

export async function startTestApi(opts: TestApiOptions = {}): Promise<TestApi> {
  const t = await startTestDatabase();
  const github = await startFakeGithub();
  const config = loadConfig("api", {
    NODE_ENV: "test",
    DATABASE_URL: t.url,
    SESSION_SECRET: "test-session-secret-that-is-long-enough-123",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    PUBLIC_APP_URL: APP_URL,
    GITHUB_OAUTH_CLIENT_ID: "gh-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "gh-client-secret-for-tests",
    GITHUB_OAUTH_BASE_URL: github.url,
    GITHUB_API_BASE_URL: github.url,
    EMAIL_TRANSPORT: "outbox",
    ...opts.env,
  });
  const queue = await startQueueClient(t.url, { retryDelaySeconds: 1 });
  const events = await createRunEventListener(t.url);
  const worker = await startWorker({
    db: t.db,
    queue,
    handlers: { "system.diagnostic": diagnosticHandler({ store: null }), ...opts.handlers },
  });
  const mail = memoryTransport();
  const { app, routes } = await buildApp({
    config,
    db: t.db,
    auth: createAuthService(t.db),
    authz: createAuthz(t.db),
    queue,
    events,
    email: mail,
    store: null,
    cookie: { secure: false },
    fetch,
  });
  return {
    app,
    routes,
    t,
    queue,
    events,
    worker,
    mail,
    github,
    async close() {
      await app.close();
      await worker.stop();
      await events.close();
      await queue.stop();
      await github.close();
      await t.stop();
    },
  };
}

export function cookieFrom(res: LightMyRequestResponse, name = "cs_session"): string | undefined {
  const c = res.cookies.find((x) => x.name === name);
  return c?.value || undefined;
}

/** Signs in through the real magic-link flow and returns the session cookie header. */
export async function signIn(api: TestApi, email: string): Promise<string> {
  const before = api.mail.sent.length;
  const req = await api.app.inject({
    method: "POST",
    url: "/v1/auth/email",
    headers: ORIGIN,
    payload: { email },
  });
  if (req.statusCode !== 202) throw new Error(`magic link request failed: ${req.body}`);
  const msg = api.mail.sent[before];
  const token = msg ? /#token=([A-Za-z0-9_-]+)/.exec(msg.text)?.[1] : undefined;
  if (!token) throw new Error("no magic link email captured");
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/auth/email/verify",
    headers: ORIGIN,
    payload: { token },
  });
  const session = cookieFrom(res);
  if (res.statusCode !== 200 || !session) throw new Error(`verify failed: ${res.body}`);
  return `cs_session=${session}`;
}

export function as(cookie: string) {
  return { cookie, ...ORIGIN };
}

/** Inserts an issue with evidence, a finding and a prompt directly (for authz tests). */
export async function seedIssue(api: TestApi, orgId: string, projectId: string, runId: string) {
  const { schema: s } = await import("@codesentra/db");
  const sys = api.t.db.system;
  const [ev] = await sys
    .insert(s.evidence)
    .values({
      orgId,
      runId,
      kind: "render_summary",
      locator: "https://seed.example/",
      payload: { text_length: 0 },
      hash: "0".repeat(64),
    })
    .returning();
  const [issue] = await sys
    .insert(s.issues)
    .values({
      orgId,
      projectId,
      fingerprint: `seed-${Math.random()}`,
      title: "Page renders blank — seed.example",
      code: "BLANK_PAGE",
      severity: "error",
      locator: "https://seed.example/",
      summary: "seeded",
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      recheck: {
        module: "pulse",
        check_group: "render",
        target: "https://seed.example/",
        expectation: "x",
      },
    })
    .returning();
  await sys.insert(s.fixPrompts).values({
    orgId,
    issueId: issue!.id,
    version: 1,
    type: "investigate",
    body: "seed prompt",
    templateVersion: "investigate@1",
  });
  return issue!.id as string;
}

export async function seedEvidence(api: TestApi, orgId: string, runId: string) {
  const { schema: s } = await import("@codesentra/db");
  const [ev] = await api.t.db.system
    .insert(s.evidence)
    .values({
      orgId,
      runId,
      kind: "http_response",
      locator: "https://secret.example.com/",
      payload: { secret: "secret.example.com" },
      hash: "1".repeat(64),
    })
    .returning();
  return ev!.id as string;
}
