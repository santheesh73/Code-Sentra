import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchPolicy, resolveTarget, SafeFetchError } from "@codesentra/ssrf";

export interface GitOptions {
  policy: FetchPolicy;
  /** Commits of history to fetch (default 2,000). */
  maxCommits?: number;
  timeoutMs?: number;
  /** Plain http is allowed only for test hosts (the harness has no TLS for git). */
  allowHttp?: boolean;
  ref?: string;
  /** Fetch exactly this commit (a full SHA) with history, instead of a branch tip. */
  commit?: string;
  /**
   * An HTTP Authorization header for the clone (a GitHub installation token). It reaches
   * git through GIT_CONFIG_* environment variables, never the command line, so it is not
   * visible in the process list, and it is never logged.
   */
  authorization?: string;
}

export class GitError extends Error {
  constructor(
    readonly code: "invalid_url" | "blocked" | "clone_failed" | "timeout" | "ref_not_found",
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "GitError";
  }
}

function envConfigOf(pairs: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return pairs.length ? env : {};
}

/**
 * Hardened git invocation: no system/global config, no hooks, no credential prompts,
 * symlinks checked out as plain files, LFS not smudged, only http(s) transports.
 * Always `execFile` with an argument array; user input never reaches a shell.
 */
export function git(
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    extraConfig?: string[];
    allowHttp?: boolean;
    /** Config passed through the environment (secrets): [key, value] pairs. */
    envConfig?: [string, string][];
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const config = [
    "core.hooksPath=/dev/null",
    "core.symlinks=false",
    "core.fsmonitor=false",
    "protocol.allow=never",
    "protocol.https.allow=always",
    ...(opts.allowHttp ? ["protocol.http.allow=always"] : []),
    "http.followRedirects=false",
    "submodule.recurse=false",
    "credential.helper=",
    ...(opts.extraConfig ?? []),
  ].flatMap((c) => ["-c", c]);
  return new Promise((ok, fail) => {
    execFile(
      "git",
      [...config, ...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: tmpdir(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/false",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_ALLOW_PROTOCOL: opts.allowHttp ? "https:http" : "https",
          ...envConfigOf(opts.envConfig ?? []),
          // No proxy variables: a proxy resolves the target itself, which would bypass the pin.
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed;
          fail(
            new GitError(
              killed ? "timeout" : "clone_failed",
              killed
                ? `git timed out after ${opts.timeoutMs ?? 120_000} ms`
                : `git ${args[0]} failed`,
              String(stderr).slice(-2000),
            ),
          );
        } else ok({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Clones a public repository with SSRF protection: the host is resolved once and every
 * address checked (ADR 0013), then git is pinned to those addresses with
 * `http.curloptResolve`, so git's own DNS cannot be rebound. Redirects are not followed.
 */
export async function cloneRepo(
  url: string,
  dest: string,
  opts: GitOptions,
): Promise<{ commitSha: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GitError("invalid_url", `not a URL: ${url}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Plain http only for hosts on the test allowance (NODE_ENV=test, ADR 0013).
  const httpOk = opts.allowHttp === true && opts.policy.allowHosts.has(host);
  if (u.protocol !== "https:" && !(httpOk && u.protocol === "http:"))
    throw new GitError("invalid_url", "only https git URLs can be cloned");
  if (u.username || u.password)
    throw new GitError("invalid_url", "credentials in the URL are not accepted");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolveTarget(u, opts.policy);
  } catch (e) {
    if (e instanceof SafeFetchError)
      throw new GitError(e.code === "blocked_address" ? "blocked" : "invalid_url", e.message);
    throw e;
  }
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const pinned = addresses.map((a) => (a.family === 6 ? `[${a.address}]` : a.address)).join(",");
  const extraConfig = [`http.curloptResolve=${host}:${port}:${pinned}`];
  const depth = String(opts.maxCommits ?? 2000);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const envConfig: [string, string][] = opts.authorization
    ? [["http.extraHeader", `Authorization: ${opts.authorization}`]]
    : [];
  if (opts.commit) {
    if (!/^[0-9a-f]{40}$/.test(opts.commit)) throw new GitError("invalid_url", "not a commit SHA");
    await git(["init", "-q", "--", dest], { timeoutMs: 10_000 });
    await git(["fetch", "--depth", depth, "--no-tags", "--", u.href, opts.commit], {
      cwd: dest,
      timeoutMs,
      extraConfig,
      allowHttp: httpOk,
      envConfig,
    }).catch((e: GitError) => {
      if (/not our ref|couldn't find remote ref|unadvertised object/i.test(e.stderr))
        throw new GitError("ref_not_found", `commit ${opts.commit} not found`, e.stderr);
      throw e;
    });
    await git(["checkout", "-q", "--detach", "FETCH_HEAD"], { cwd: dest, timeoutMs: 60_000 });
    const { stdout } = await git(["rev-parse", "HEAD"], { cwd: dest, timeoutMs: 10_000 });
    return { commitSha: stdout.trim() };
  }
  await git(
    [
      "clone",
      "--depth",
      depth,
      "--single-branch",
      "--no-tags",
      ...(opts.ref ? ["--branch", opts.ref] : []),
      "--",
      u.href,
      dest,
    ],
    { timeoutMs, extraConfig, allowHttp: httpOk, envConfig },
  ).catch((e: GitError) => {
    if (opts.ref && /Remote branch .* not found|couldn't find remote ref/i.test(e.stderr))
      throw new GitError("ref_not_found", `ref ${opts.ref} not found`, e.stderr);
    throw e;
  });
  const { stdout } = await git(["rev-parse", "HEAD"], { cwd: dest, timeoutMs: 10_000 });
  return { commitSha: stdout.trim() };
}

/** `git log` for the History stage: up to `max` commits, newest first, no renames. */
export async function gitLog(repoDir: string, max = 2000): Promise<string> {
  const { stdout } = await git(
    ["log", `-n${max}`, "--name-only", "--no-renames", "--format=%x1e%H%x1f%aE%x1f%aI"],
    { cwd: repoDir, timeoutMs: 60_000 },
  );
  return stdout;
}

export async function scratchDir(
  prefix = "cs-scan-",
): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
