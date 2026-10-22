import { createHmac, createSign, timingSafeEqual } from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  /** PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
  /** https://api.github.com, or a GitHub Enterprise / test base URL. */
  apiBaseUrl: string;
  fetch?: typeof fetch;
  /** Clock override for tests (ms since epoch). */
  now?: () => number;
  timeoutMs?: number;
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The App's own JWT (RS256, 9-minute lifetime, issued 60 s in the past for clock skew). */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * `X-Hub-Signature-256` check over the raw body (constant-time). Deliveries that fail it
 * are rejected before anything is parsed.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface CheckRunInput {
  name: string;
  head_sha: string;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "action_required";
  details_url?: string;
  external_id?: string;
  output?: { title: string; summary: string; text?: string };
}

const OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,255}$/;

/**
 * The CodeSentra GitHub App: installation tokens (cached until a minute before they
 * expire) and the few REST calls it needs (Section 16: contents read, checks write,
 * pull requests read, deployments read, metadata read).
 */
export class GithubApp {
  private tokens = new Map<number, { token: string; expiresAt: number }>();
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: GithubAppConfig) {
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  private url(path: string) {
    return new URL(path.replace(/^\//, ""), `${this.cfg.apiBaseUrl.replace(/\/$/, "")}/`);
  }

  private async call(
    path: string,
    init: { method?: string; auth: string; body?: unknown; accept?: string },
  ): Promise<Response> {
    const res = await this.f(this.url(path), {
      method: init.method ?? "GET",
      headers: {
        accept: init.accept ?? "application/vnd.github+json",
        authorization: init.auth,
        "x-github-api-version": "2022-11-28",
        "user-agent": "CodeSentra",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    return res;
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GithubError(res.status, `${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const jwt = appJwt(this.cfg.appId, this.cfg.privateKey, this.now());
    const res = await this.call(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      auth: `Bearer ${jwt}`,
    });
    const body = await this.json<{ token: string; expires_at: string }>(res, "installation token");
    this.tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  private async asInstallation(id: number) {
    return `token ${await this.installationToken(id)}`;
  }

  private repoPath(owner: string, repo: string) {
    if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repo))
      throw new GithubError(400, "bad repository name");
    return `/repos/${owner}/${repo}`;
  }

  async createCheckRun(installationId: number, owner: string, repo: string, input: CheckRunInput) {
    const res = await this.call(`${this.repoPath(owner, repo)}/check-runs`, {
      method: "POST",
      auth: await this.asInstallation(installationId),
      body: input,
    });
    return this.json<{ id: number }>(res, "create check run");
  }

  async updateCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    checkRunId: number,
    input: Partial<CheckRunInput>,
  ) {
    const res = await this.call(`${this.repoPath(owner, repo)}/check-runs/${checkRunId}`, {
      method: "PATCH",
      auth: await this.asInstallation(installationId),
      body: input,
    });
    return this.json<{ id: number }>(res, "update check run");
  }

  /** Files changed between two commits (a PR's base and head). */
  async changedFiles(
    installationId: number,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<string[]> {
    if (!REF.test(base) || !REF.test(head)) throw new GithubError(400, "bad ref");
    const res = await this.call(`${this.repoPath(owner, repo)}/compare/${base}...${head}`, {
      auth: await this.asInstallation(installationId),
    });
    const body = await this.json<{ files?: { filename: string; previous_filename?: string }[] }>(
      res,
      "compare",
    );
    return [
      ...new Set(
        (body.files ?? []).flatMap((f) => [
          f.filename,
          ...(f.previous_filename ? [f.previous_filename] : []),
        ]),
      ),
    ].sort();
  }

  /**
   * The repository at `ref` as a zip (GitHub's zipball, one top-level directory). The API
   * answers with a redirect to its download host; only that host and the API host are
   * followed, and the body is capped.
   */
  async zipball(
    installationId: number,
    owner: string,
    repo: string,
    ref: string,
    maxBytes: number,
  ): Promise<Buffer> {
    if (!REF.test(ref)) throw new GithubError(400, "bad ref");
    const auth = await this.asInstallation(installationId);
    const api = new URL(this.cfg.apiBaseUrl);
    let res = await this.call(`${this.repoPath(owner, repo)}/zipball/${ref}`, { auth });
    for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, api);
      const allowed =
        next.host === api.host ||
        (next.protocol === "https:" && next.hostname === "codeload.github.com");
      if (!allowed)
        throw new GithubError(502, `zipball redirected to an unexpected host: ${next.host}`);
      res = await this.f(next, {
        redirect: "manual",
        headers:
          next.host === api.host
            ? { authorization: auth, "user-agent": "CodeSentra" }
            : { "user-agent": "CodeSentra" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
      });
    }
    if (!res.ok || !res.body) throw new GithubError(res.status, `zipball: HTTP ${res.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > maxBytes)
        throw new GithubError(413, `the repository archive exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
}
