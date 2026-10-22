import { launchPulseBrowser } from "@codesentra/checks";
import { type Harness, startHarness } from "@codesentra/fixture-harness";
import { testPolicy } from "@codesentra/ssrf";
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
    [["scan"], "not available yet (planned for Phase 3)"],
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
