import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `codesentra login` and `codesentra check` (Section 15): the CLI talks to a CodeSentra
 * API with an API token. The token is stored in the user's config file (mode 0600) or
 * read from CODESENTRA_TOKEN; it is never printed.
 */
export interface RemoteDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Reads the token when --token - is given (stdin). */
  readStdin(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export interface StoredConfig {
  api_url: string;
  token: string;
}

export class RemoteError extends Error {}

export function configPath(env: Record<string, string | undefined>): string {
  if (env.CODESENTRA_CONFIG) return env.CODESENTRA_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "codesentra", "config.json");
}

async function readConfig(env: Record<string, string | undefined>): Promise<StoredConfig | null> {
  try {
    const raw = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<StoredConfig>;
    return raw.api_url && raw.token ? { api_url: raw.api_url, token: raw.token } : null;
  } catch {
    return null;
  }
}

/** The API base (…/v1 is appended) and token: env vars win over the stored login. */
export async function credentials(deps: RemoteDeps): Promise<StoredConfig> {
  const stored = await readConfig(deps.env);
  const api_url = deps.env.CODESENTRA_API_URL || stored?.api_url;
  const token = deps.env.CODESENTRA_TOKEN || stored?.token;
  if (!api_url || !token)
    throw new RemoteError(
      "not logged in: run `codesentra login --api <url>` (or set CODESENTRA_API_URL and CODESENTRA_TOKEN)",
    );
  return { api_url: api_url.replace(/\/+$/, ""), token };
}

async function call<T>(
  deps: RemoteDeps,
  c: StoredConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await deps.fetch(`${c.api_url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new RemoteError(`could not reach ${c.api_url}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; reported below
  }
  if (!res.ok) {
    const detail =
      (json as { detail?: string; title?: string } | null)?.detail ??
      (json as { title?: string } | null)?.title;
    if (res.status === 401)
      throw new RemoteError(
        `the API token was refused (${detail ?? "401"}); run codesentra login again`,
      );
    throw new RemoteError(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return json as T;
}

interface Me {
  user: { email: string };
  organizations: { id: string; name: string }[];
}

export async function login(
  deps: RemoteDeps,
  opts: { api?: string; token?: string },
): Promise<string> {
  const stored = await readConfig(deps.env);
  const api_url = (opts.api || deps.env.CODESENTRA_API_URL || stored?.api_url || "").replace(
    /\/+$/,
    "",
  );
  if (!api_url)
    throw new RemoteError("--api <url> is required the first time (e.g. https://your-host/api)");
  let token =
    opts.token === "-" ? (await deps.readStdin()).trim() : opts.token || deps.env.CODESENTRA_TOKEN;
  if (!token)
    throw new RemoteError(
      "pass --token - and pipe the token on stdin (create one in Settings → API tokens), or set CODESENTRA_TOKEN",
    );
  token = token.trim();
  if (!/^cs_[A-Za-z0-9_-]{20,}$/.test(token))
    throw new RemoteError("that does not look like a CodeSentra API token (cs_…)");
  const me = await call<Me>(deps, { api_url, token }, "GET", "/v1/me");
  const file = configPath(deps.env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ api_url, token }, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  const org = me.organizations[0];
  return `Logged in to ${api_url} as ${me.user.email}${org ? ` (organization: ${org.name})` : ""}.\nSaved to ${file}.\n`;
}

interface RunOut {
  id: string;
  type: string;
  status: string;
  error: string | null;
  outcome: Record<string, unknown> | null;
  gaps: { step: string; reason: string }[];
  children: {
    id: string;
    type: string;
    status: string;
    target_url: string | null;
    outcome: Record<string, unknown> | null;
    error: string | null;
  }[];
}
interface IssueOut {
  id: string;
  title: string;
  code: string;
  severity: "error" | "warning" | "info";
  status: string;
  locator: string;
}

const TERMINAL = new Set(["succeeded", "failed", "partial"]);

export interface CheckResult {
  text: string;
  json: unknown;
  exitCode: number;
}

/**
 * Starts a full check and, with --wait, follows it to the end. Exit codes follow Section
 * 15: 2 if a deployment is down; 1 if one is degraded or unverified, an error-severity
 * issue is open, or any part of the check did not run; else 0.
 */
export async function check(
  deps: RemoteDeps,
  opts: { project: string; wait: boolean; fixPrompt: boolean; timeoutSeconds: number },
): Promise<CheckResult> {
  const c = await credentials(deps);
  const started = await call<{ run_id: string }>(
    deps,
    c,
    "POST",
    `/v1/projects/${opts.project}/check`,
    {},
  );
  if (!opts.wait) {
    return {
      text: `Started check ${started.run_id}. Follow it with: codesentra check --project ${opts.project} --wait\n`,
      json: { run_id: started.run_id, status: "queued" },
      exitCode: 0,
    };
  }
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let run = await call<RunOut>(deps, c, "GET", `/v1/runs/${started.run_id}`);
  while (!TERMINAL.has(run.status)) {
    if (Date.now() > deadline)
      throw new RemoteError(
        `the check did not finish within ${opts.timeoutSeconds} s (run ${run.id})`,
      );
    await deps.sleep(2000);
    run = await call<RunOut>(deps, c, "GET", `/v1/runs/${started.run_id}`);
  }
  const issues = await call<IssueOut[]>(
    deps,
    c,
    "GET",
    `/v1/projects/${opts.project}/issues?status=open,regressed`,
  );
  const prompts = new Map<string, { type: string; body: string }>();
  if (opts.fixPrompt)
    for (const i of issues)
      prompts.set(i.id, await call(deps, c, "GET", `/v1/issues/${i.id}/fix-prompt`));

  const statuses = run.children
    .filter((k) => k.type === "pulse")
    .map((k) => ({
      url: k.target_url,
      status: (k.outcome?.pulse_status as string | undefined) ?? "unverified",
    }));
  const notRun = [
    ...run.gaps.map((g) => `${g.step}: ${g.reason}`),
    ...run.children
      .filter((k) => k.status === "failed")
      .map((k) => `${k.type}: ${k.error ?? "failed"}`),
  ];
  const errors = issues.filter((i) => i.severity === "error").length;
  let exitCode = 0;
  if (
    statuses.some((s) => s.status === "degraded" || s.status === "unverified") ||
    errors > 0 ||
    notRun.length ||
    run.status !== "succeeded"
  )
    exitCode = 1;
  if (statuses.some((s) => s.status === "down")) exitCode = 2;

  const lines = [`CodeSentra check · run ${run.id} · ${run.status.toUpperCase()}`];
  for (const s of statuses) lines.push(`Deployment ${s.url}: ${s.status.toUpperCase()}`);
  for (const k of run.children.filter((x) => x.type === "scan")) lines.push(`Scan: ${k.status}`);
  if (notRun.length) {
    lines.push("", "Not checked:");
    for (const g of notRun) lines.push(`  ${g}`);
  }
  lines.push("", issues.length ? `Open issues (${issues.length}):` : "No open issues.");
  for (const i of issues)
    lines.push(`  ${i.severity.toUpperCase().padEnd(7)} ${i.title}  [${i.code}] ${i.locator}`);
  for (const i of issues) {
    const p = prompts.get(i.id);
    if (p) lines.push("", `── Fix prompt: ${i.title} (${p.type}) ──`, p.body.trimEnd());
  }
  if (!opts.fixPrompt && issues.length)
    lines.push("", "Run again with --fix-prompt for a prompt per issue.");
  return {
    text: `${lines.join("\n")}\n`,
    json: {
      run_id: run.id,
      status: run.status,
      deployments: statuses,
      not_checked: notRun,
      issues: issues.map((i) => ({ ...i, prompt: prompts.get(i.id) ?? null })),
    },
    exitCode,
  };
}
