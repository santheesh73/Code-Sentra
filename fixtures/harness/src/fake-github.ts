import {
  createHmac,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import yazl from "yazl";

/**
 * A local stand-in for the GitHub REST API as the CodeSentra GitHub App uses it (no test
 * talks to github.com). It verifies the App JWT against a generated key pair, issues
 * installation tokens, records check runs, answers compare from registered commits, and
 * serves zipballs through a redirect like the real API. `deliver` signs and posts a
 * webhook the way GitHub does.
 */
export interface FakeGithubApp {
  url: string;
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  /** Registers a commit: the full tree at `sha` (path → content). */
  commit(repo: string, sha: string, files: Record<string, string | Buffer>): void;
  checkRuns: FakeCheckRun[];
  /** Calls the API made, as `METHOD path`. */
  calls: string[];
  /** A user-authorization code whose user can access these installations. */
  authorize(code: string, installationIds: number[]): void;
  clientId: string;
  clientSecret: string;
  deliver(
    target: string,
    event: string,
    payload: unknown,
    opts?: { deliveryId?: string; secret?: string },
  ): Promise<Response>;
  close(): Promise<void>;
}

export interface FakeCheckRun {
  id: number;
  repo: string;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  output: { title: string; summary: string; text?: string } | null;
  details_url: string | null;
  updates: number;
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((ok) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
  });

function verifyJwt(jwt: string, publicKeyPem: string, appId: string): boolean {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  const ok = createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(createPublicKey(publicKeyPem), Buffer.from(s, "base64url"));
  if (!ok) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as {
    iss: string;
    exp: number;
  };
  return claims.iss === appId && claims.exp > Date.now() / 1000;
}

async function zipOf(top: string, files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, content] of Object.entries(files))
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), `${top}/${path}`);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeGithubApp(): Promise<FakeGithubApp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const appId = "424242";
  const webhookSecret = randomBytes(24).toString("hex");
  const tokens = new Set<string>();
  const commits = new Map<string, Map<string, Record<string, string | Buffer>>>();
  const checkRuns: FakeCheckRun[] = [];
  const calls: string[] = [];
  const codes = new Map<string, number[]>();
  const userTokens = new Map<string, number[]>();
  const clientId = "Iv1.fakeapp00000001";
  const clientSecret = randomBytes(16).toString("hex");
  let nextId = 1000;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? "";
    let m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      if (!verifyJwt(auth.replace(/^Bearer /, ""), publicKeyPem, appId))
        return json(401, { message: "A JSON web token could not be decoded" });
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      tokens.add(token);
      return json(201, {
        token,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse((await readBody(req)).toString() || "{}") as {
        client_id?: string;
        client_secret?: string;
        code?: string;
      };
      const installs = body.code ? codes.get(body.code) : undefined;
      if (body.client_id !== clientId || body.client_secret !== clientSecret || !installs)
        return json(200, { error: "bad_verification_code" });
      codes.delete(body.code as string);
      const token = `ghu_${randomBytes(18).toString("hex")}`;
      userTokens.set(token, installs);
      return json(200, { access_token: token, token_type: "bearer" });
    }
    if (req.method === "GET" && url.pathname === "/user/installations") {
      const ids = userTokens.get(auth.replace(/^token /, ""));
      if (!ids) return json(401, { message: "Bad credentials" });
      return json(200, { total_count: ids.length, installations: ids.map((id) => ({ id })) });
    }
    // The download host: zipballs (unauthenticated, as codeload is).
    m = /^\/__codeload\/([^/]+\/[^/]+)\/([0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const files = commits.get(m[1] as string)?.get(m[2] as string);
      if (!files) return json(404, { message: "Not Found" });
      const name = (m[1] as string).replace("/", "-");
      const body = await zipOf(`${name}-${(m[2] as string).slice(0, 7)}`, files);
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(body);
    }
    if (!tokens.has(auth.replace(/^token /, ""))) return json(401, { message: "Bad credentials" });

    m = /^\/repos\/([^/]+\/[^/]+)\/zipball\/([0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      res.writeHead(302, { location: `/__codeload/${m[1]}/${m[2]}` });
      return res.end();
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const repo = commits.get(m[1] as string);
      const base = repo?.get(m[2] as string);
      const head = repo?.get(m[3] as string);
      if (!base || !head) return json(404, { message: "Not Found" });
      const paths = new Set([...Object.keys(base), ...Object.keys(head)]);
      const files = [...paths]
        .filter((p) => String(base[p] ?? "") !== String(head[p] ?? ""))
        .map((filename) => ({ filename }));
      return json(200, { files });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/check-runs(?:\/(\d+))?$/.exec(url.pathname);
    if (m && (req.method === "POST" || req.method === "PATCH")) {
      const body = JSON.parse((await readBody(req)).toString() || "{}") as Partial<FakeCheckRun>;
      if (req.method === "POST") {
        const run: FakeCheckRun = {
          id: nextId++,
          repo: m[1] as string,
          name: body.name ?? "",
          head_sha: body.head_sha ?? "",
          status: body.status ?? "queued",
          conclusion: body.conclusion ?? null,
          output: body.output ?? null,
          details_url: body.details_url ?? null,
          updates: 0,
        };
        checkRuns.push(run);
        return json(201, { id: run.id });
      }
      const run = checkRuns.find((r) => r.id === Number(m?.[2]));
      if (!run) return json(404, { message: "Not Found" });
      Object.assign(run, {
        ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
        updates: run.updates + 1,
      });
      return json(200, { id: run.id });
    }
    json(404, { message: "Not Found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    appId,
    privateKeyPem,
    webhookSecret,
    checkRuns,
    calls,
    clientId,
    clientSecret,
    authorize(code, installationIds) {
      codes.set(code, installationIds);
    },
    commit(repo, sha, files) {
      const m = commits.get(repo) ?? new Map();
      m.set(sha, files);
      commits.set(repo, m);
    },
    async deliver(target, event, payload, opts = {}) {
      const body = JSON.stringify(payload);
      const sig = createHmac("sha256", opts.secret ?? webhookSecret)
        .update(body)
        .digest("hex");
      return fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": opts.deliveryId ?? randomUUID(),
          "x-hub-signature-256": `sha256=${sig}`,
          "user-agent": "GitHub-Hookshot/fake",
        },
        body,
      });
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
