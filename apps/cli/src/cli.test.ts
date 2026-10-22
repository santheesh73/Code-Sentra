import { join } from "node:path";
import { launchPulseBrowser } from "@codesentra/checks";
import {
  FIXTURE_REPOS_DIR,
  fixtureReportModel,
  type Harness,
  loadFixtureRepos,
  startHarness,
} from "@codesentra/fixture-harness";
import { offlineSource } from "@codesentra/scan";
import { defaultPolicy, testPolicy } from "@codesentra/ssrf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliDeps, run } from "./cli.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => h?.close());

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        err += t;
      },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

const deps = (over: Partial<CliDeps> = {}): CliDeps => ({
  env: {},
  launchBrowser: launchPulseBrowser,
  policy: testPolicy(["127.0.0.1"], { ca: h.caCertPem }),
  ...over,
});

const app = (name: string) => {
  const t = h.targets.apps[name];
  if (!t) throw new Error(`${name} not served`);
  return t.url;
};

describe("codesentra pulse", () => {
  it("healthy → live, zero issues, exit 0", async () => {
    const c = capture();
    const code = await run(["pulse", app("healthy"), "--json"], c.io, deps());
    const json = JSON.parse(c.out);
    expect({ code, status: json.status, issues: json.issues, gaps: json.gaps }).toEqual({
      code: 0,
      status: "live",
      issues: [],
      gaps: [],
    });
  });

  it("env-undefined → degraded, exit 1, merged issue with a prompt", async () => {
    h.setVariant("env-undefined", "broken");
    const c = capture();
    const code = await run(["pulse", app("env-undefined"), "--json"], c.io, deps());
    const json = JSON.parse(c.out);
    expect(code).toBe(1);
    expect(json.status).toBe("degraded");
    expect(json.issues).toHaveLength(1);
    expect(json.issues[0].code).toBe("UNDEFINED_IN_URL");
    expect(json.issues[0].corroborating_codes).toEqual(["SAME_ORIGIN_FAILURE"]);
    expect(json.issues[0].prompt.body).toContain("/undefined/api/ping");
    for (const f of json.findings) expect(f.evidence, f.code).not.toBeNull();
  });

  it("--fix-prompt prints the prompt in text output", async () => {
    h.setVariant("env-undefined", "broken");
    const c = capture();
    const code = await run(["pulse", app("env-undefined"), "--fix-prompt"], c.io, deps());
    expect(code).toBe(1);
    expect(c.out).toContain("Status: DEGRADED");
    expect(c.out).toContain("── Fix prompt:");
    expect(c.out).toContain("/undefined/api/ping");
  });

  it("a 500 → down, exit 2, outage triage prompt", async () => {
    const c = capture();
    const code = await run(
      ["pulse", h.targets.simulators["server-error"].url, "--json"],
      c.io,
      deps(),
    );
    const json = JSON.parse(c.out);
    expect(code).toBe(2);
    expect(json.status).toBe("down");
    expect(json.issues.map((i: { prompt: { type: string } }) => i.prompt.type)).toContain(
      "outage_triage",
    );
  });

  it("no browser → unverified with the render gap, never exit 0", async () => {
    const c = capture();
    const code = await run(
      ["pulse", app("healthy"), "--json"],
      c.io,
      deps({ launchBrowser: async () => ({ browser: null, reason: "Chromium not found" }) }),
    );
    const json = JSON.parse(c.out);
    expect(code).toBe(1);
    expect(json.status).toBe("unverified");
    expect(json.gaps).toEqual([
      { group: "render", reason: expect.stringContaining("Chromium not found") },
    ]);
  });

  it("loopback targets are refused under the default policy (SSRF)", async () => {
    const c = capture();
    const code = await run(["pulse", app("healthy"), "--json"], c.io, {
      env: {},
      launchBrowser: async () => ({ browser: null, reason: "not needed" }),
    });
    const json = JSON.parse(c.out);
    expect(code).toBe(1);
    expect(json.status).toBe("unverified");
    expect(json.gaps[0].group).toBe("reachability");
  });

  it("the loopback allowance from the environment is refused outside tests", async () => {
    const c = capture();
    const code = await run(["pulse", app("healthy")], c.io, {
      env: { NODE_ENV: "production", PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
      launchBrowser: async () => ({ browser: null, reason: "not needed" }),
    });
    expect(code).toBe(3);
    expect(c.err).toContain("only available when NODE_ENV=test");
  });
});

describe("usage", () => {
  const noBrowser = deps;
  it.each([
    [["pulse"], "exactly one URL"],
    [["pulse", "not a url"], "not a URL"],
    [["pulse", "ftp://example.com"], "only http and https"],
    [["pulse", "https://example.com", "--timeout=abc"], "--timeout"],
    [["pulse", "https://example.com", "--bogus"], "Unknown option"],
    [["frobnicate"], "unknown command"],
    [["check"], "check needs --project"],
    [["check", "--project", "nope"], "check needs --project"],
    [["scan", "/definitely/not/here"], "not a directory"],
    [["scan", "a", "b"], "at most one"],
  ])("%j → exit 3", async (argv, message) => {
    const c = capture();
    expect(await run(argv, c.io, noBrowser())).toBe(3);
    expect(c.err).toContain(message);
  });

  it("--help → exit 0", async () => {
    const c = capture();
    expect(await run(["pulse", "--help"], c.io, deps())).toBe(0);
    expect(c.out).toContain("Exit codes");
  });
});

describe("scan", () => {
  // Sandbox and gitleaks are withheld here (they are gaps); the sandboxed gate runs in
  // packages/scan and e2e. The scripted fixture model stands in for the LLM (ADR 0017).
  const scanDeps = async (): Promise<CliDeps> => ({
    ...deps(),
    scanEnv: async () => ({
      sandbox: { sandbox: null, reason: "no sandbox in CLI tests" },
      osv: { source: await offlineSource(join(FIXTURE_REPOS_DIR, "../osv")) },
      secrets: { enabled: false, reason: "gitleaks not run in CLI tests" },
      model: { model: fixtureReportModel() },
      gitPolicy: testPolicy(["127.0.0.1"]),
      allowHttpGit: false,
    }),
  });
  const repo = loadFixtureRepos().find((r) => r.expected.name === "ts-taskboard");

  it("scans a directory: features, findings with prompts, verified report, gaps → exit 1", async () => {
    const c = capture();
    const code = await run(["scan", repo?.repoDir as string, "--json"], c.io, await scanDeps());
    expect(code).toBe(1);
    const j = JSON.parse(c.out);
    expect(j.features.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining(repo?.expected.features.map((f) => f.name) ?? []),
    );
    expect(j.findings).toContainEqual(
      expect.objectContaining({ code: "STUB_IMPLEMENTATION", locator: "src/lib/csv.ts:4" }),
    );
    expect(j.findings).toContainEqual(
      expect.objectContaining({ code: "VULNERABLE_DEPENDENCY", locator: "package-lock.json" }),
    );
    expect(j.gaps.map((g: { stage: string }) => g.stage)).toContain("probe");
    for (const f of repo?.expected.forbiddenClaims ?? [])
      expect(j.report.map((r: { text: string }) => r.text)).not.toContain(f.text);
    expect(j.issues.length).toBeGreaterThan(0);
    for (const i of j.issues) expect(i.prompt.body.length).toBeGreaterThan(0);
  }, 120_000);

  it("prints a readable summary", async () => {
    const c = capture();
    await run(["scan", repo?.repoDir as string], c.io, await scanDeps());
    expect(c.out).toContain("CodeSentra Scan");
    expect(c.out).toContain("Not checked:");
    expect(c.out).toContain("Features:");
  }, 120_000);

  it("refuses private git URLs before cloning", async () => {
    const c = capture();
    const d = await scanDeps();
    const env = await (d.scanEnv as NonNullable<CliDeps["scanEnv"]>)();
    const code = await run(["scan", "https://10.0.0.1/repo.git"], c.io, {
      ...d,
      scanEnv: async () => ({ ...env, gitPolicy: defaultPolicy() }),
    });
    expect(code).toBe(3);
    expect(c.err).toMatch(/blocked|not allowed|private|global/i);
  });
});
