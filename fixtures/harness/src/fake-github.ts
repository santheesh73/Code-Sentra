import { execFileSync, spawn } from "node:child_process";
import {
  createHmac,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Registers a commit: the full tree at `sha` (path → content). No git history. */
  commit(repo: string, sha: string, files: Record<string, string | Buffer>): void;
  /**
   * Makes a real git commit (the full tree), served over smart HTTP at
   * `<url>/<owner>/<repo>.git` to installation tokens, and registered for compare and
   * zipball. Returns its SHA.
   */
  gitCommit(repo: string, files: Record<string, string | Buffer>, message?: string): string;
  /** Base URL for git clones (`<gitBaseUrl>/<owner>/<repo>.git`). */
  gitBaseUrl: string;
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

/** `git http-backend` as CGI for bare repos under `root` (fetch by any SHA allowed, as GitHub). */
function gitBackendIn(root: string) {
  return (req: IncomingMessage, res: ServerResponse, pathInfo: string, query: string) => {
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "uploadpack.allowAnySHA1InWant",
        GIT_CONFIG_VALUE_0: "true",
        PATH_INFO: decodeURIComponent(pathInfo),
        QUERY_STRING: query,
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf("\r\n\r\n");
      if (sep === -1) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, sep).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
        else res.setHeader(k, v);
      }
      res.writeHead(status);
      res.write(head.subarray(sep + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.on("error", () => res.end());
  };
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
  const gitRoot = mkdtempSync(join(tmpdir(), "cs-fake-gh-git-"));
  const workdirs = new Map<string, string>();
  /** The default branch's head per repository (the last gitCommit). */
  const heads = new Map<string, string>();
  let commitClock = Date.parse("2026-01-01T00:00:00Z");
  const runGit = (cwd: string, args: string[], date?: string) =>
    execFileSync("git", ["-c", "user.name=dev", "-c", "user.email=dev@example.com", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: gitRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    })
      .toString()
      .trim();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? "";
    // Git smart HTTP for gitCommit() repos, authenticated like GitHub's installation tokens.
    const g = /^\/([^/]+\/[^/]+)\.git(\/.*)$/.exec(url.pathname);
    if (g) {
      const basic = /^Basic (.+)$/.exec(auth)?.[1];
      const [user, pass] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
      if (user !== "x-access-token" || !pass || !tokens.has(pass)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
        return res.end();
      }
      return gitBackend(req, res, `/${g[1]}.git${g[2]}`, url.search.slice(1));
    }
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
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      // A branch name (or HEAD) is the latest gitCommit(); a SHA is itself if known.
      const ref = decodeURIComponent(m[2] as string);
      const known = commits.get(m[1] as string);
      const sha = /^[0-9a-f]{40}$/.test(ref)
        ? known?.has(ref)
          ? ref
          : null
        : (heads.get(m[1] as string) ?? null);
      if (!sha) return json(404, { message: "No commit found for SHA" });
      return json(200, { sha });
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
  const gitBackend = gitBackendIn(gitRoot);
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
    gitBaseUrl: url,
    gitCommit(repo, files, message = "commit") {
      let work = workdirs.get(repo);
      if (!work) {
        work = mkdtempSync(join(gitRoot, "work-"));
        runGit(work, ["init", "-q", "-b", "main"]);
        workdirs.set(repo, work);
      }
      for (const f of runGit(work, ["ls-files"]).split("\n").filter(Boolean))
        rmSync(join(work, f), { force: true });
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
      commitClock += 3_600_000;
      runGit(work, ["add", "-A"]);
      runGit(
        work,
        ["commit", "-q", "--allow-empty", "-m", message],
        new Date(commitClock).toISOString(),
      );
      const sha = runGit(work, ["rev-parse", "HEAD"]);
      const bare = join(gitRoot, `${repo}.git`);
      if (!existsSync(bare)) {
        mkdirSync(bare, { recursive: true });
        runGit(bare, ["init", "-q", "--bare", "-b", "main"]);
      }
      runGit(work, ["push", "-q", "--force", bare, "HEAD:refs/heads/main"]);
      const m = commits.get(repo) ?? new Map();
      m.set(sha, files);
      commits.set(repo, m);
      heads.set(repo, sha);
      return sha;
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
    close: () =>
      new Promise((ok) =>
        server.close(() => {
          rmSync(gitRoot, { recursive: true, force: true });
          ok();
        }),
      ),
  };
}
