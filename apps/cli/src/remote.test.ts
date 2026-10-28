import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliDeps, run } from "./cli.js";

const TOKEN = `cs_${"a".repeat(43)}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";

/** A stub API: answers by `METHOD path`, records calls and the Authorization header. */
function stubApi(routes: Record<string, (n: number) => unknown>) {
  const calls: string[] = [];
  const auth: string[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname.replace(/^\/api/, "")}${u.search}`;
    calls.push(key);
    auth.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ title: "Not found" }), { status: 404 });
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const body = handler(n);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls, auth };
}

function capture() {
  const o = { out: "", err: "" };
  return {
    o,
    io: {
      out: (t: string) => {
        o.out += t;
      },
      err: (t: string) => {
        o.err += t;
      },
    },
  };
}

async function depsWith(
  api: ReturnType<typeof stubApi>,
  env: Record<string, string> = {},
): Promise<CliDeps> {
  const dir = await mkdtemp(join(tmpdir(), "cs-cli-"));
  return {
    env: { CODESENTRA_CONFIG: join(dir, "config.json"), ...env },
    launchBrowser: async () => ({ browser: null, reason: "not used" }),
    remote: { fetch: api.fetchImpl, readStdin: async () => `${TOKEN}\n`, sleep: async () => {} },
  };
}

const me = { user: { email: "dev@example.com" }, organizations: [{ id: "o", name: "acme" }] };
const run0 = (status: string, children: unknown[], gaps: unknown[] = []) => ({
  id: "22222222-2222-4222-8222-222222222222",
  type: "link",
  status,
  error: null,
  outcome: {},
  gaps,
  children,
});
const pulseKid = (pulse_status: string) => ({
  id: "k",
  type: "pulse",
  status: "succeeded",
  target_url: "https://app.example/",
  outcome: { pulse_status },
  error: null,
});

describe("codesentra login", () => {
  it("verifies the token, stores it 0600 and never prints it", async () => {
    const api = stubApi({ "GET /v1/me": () => me });
    const deps = await depsWith(api);
    const c = capture();
    expect(
      await run(["login", "--api", "https://cs.example/api/", "--token", "-"], c.io, deps),
    ).toBe(0);
    expect(c.o.out).toContain("as dev@example.com (organization: acme)");
    expect(c.o.out).not.toContain(TOKEN);
    expect(api.auth[0]).toBe(`Bearer ${TOKEN}`);
    const file = deps.env.CODESENTRA_CONFIG as string;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      api_url: "https://cs.example/api",
      token: TOKEN,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses a malformed or rejected token, and needs --api the first time", async () => {
    const refused = stubApi({
      "GET /v1/me": () => new Response(JSON.stringify({ detail: "revoked" }), { status: 401 }),
    });
    const c = capture();
    expect(
      await run(
        ["login", "--api", "https://cs.example/api", "--token", "-"],
        c.io,
        await depsWith(refused),
      ),
    ).toBe(3);
    expect(c.o.err).toContain("refused (revoked)");
    const c2 = capture();
    expect(await run(["login", "--token", "-"], c2.io, await depsWith(stubApi({})))).toBe(3);
    expect(c2.o.err).toContain("--api <url> is required");
    const c3 = capture();
    const bad = await depsWith(stubApi({}));
    bad.remote = { ...bad.remote, readStdin: async () => "hunter2" };
    expect(await run(["login", "--api", "https://x/api", "--token", "-"], c3.io, bad)).toBe(3);
    expect(c3.o.err).toContain("does not look like a CodeSentra API token");
  });
});

describe("codesentra check", () => {
  const env = { CODESENTRA_API_URL: "https://cs.example/api", CODESENTRA_TOKEN: TOKEN };
  const checkRoutes = (runBody: (n: number) => unknown, issues: unknown[] = []) =>
    stubApi({
      [`POST /v1/projects/${PROJECT}/check`]: () => ({
        run_id: "22222222-2222-4222-8222-222222222222",
      }),
      "GET /v1/runs/22222222-2222-4222-8222-222222222222": runBody,
      [`GET /v1/projects/${PROJECT}/issues?status=open,regressed`]: () => issues,
      "GET /v1/issues/i1/fix-prompt": () => ({
        type: "code_fix",
        body: "Set NEXT_PUBLIC_API_URL.",
      }),
    });

  it("without --wait prints the run and exits 0", async () => {
    const api = checkRoutes(() => run0("queued", []));
    const c = capture();
    expect(await run(["check", "--project", PROJECT], c.io, await depsWith(api, env))).toBe(0);
    expect(c.o.out).toContain("Started check 22222222");
  });

  it("--wait polls to the end; exit codes follow Section 15", async () => {
    const issue = {
      id: "i1",
      title: "Undefined in URL",
      code: "UNDEFINED_IN_URL",
      severity: "error",
      status: "open",
      locator: "/undefined/api/ping",
    };
    const cases: [unknown, unknown[], number][] = [
      [run0("succeeded", [pulseKid("live")]), [], 0],
      [run0("succeeded", [pulseKid("degraded")]), [issue], 1],
      [run0("succeeded", [pulseKid("down")]), [], 2],
      [run0("partial", [pulseKid("live")], [{ step: "trace", reason: "no Scan" }]), [], 1],
    ];
    for (const [final, issues, code] of cases) {
      const api = checkRoutes((n) => (n < 3 ? run0("running", []) : final), issues);
      const c = capture();
      expect(
        await run(
          ["check", "--project", PROJECT, "--wait", "--fix-prompt"],
          c.io,
          await depsWith(api, env),
        ),
        JSON.stringify(final),
      ).toBe(code);
      expect(api.calls.filter((x) => x.startsWith("GET /v1/runs/")).length).toBe(3);
      if (issues.length) expect(c.o.out).toContain("Set NEXT_PUBLIC_API_URL.");
    }
  });

  it("says how to log in when there is no token", async () => {
    const c = capture();
    expect(await run(["check", "--project", PROJECT], c.io, await depsWith(stubApi({})))).toBe(3);
    expect(c.o.err).toContain("not logged in");
  });
});
