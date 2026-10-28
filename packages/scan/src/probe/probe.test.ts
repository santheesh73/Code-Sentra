import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureRepos } from "@codesentra/fixture-harness";
import { createSandbox, type Sandbox } from "@codesentra/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSecrets } from "../secrets.js";
import { parseErrorLines, parseTestOutput } from "./parse.js";
import {
  checkNpmLockUrls,
  type ProjectView,
  planProbes,
  SANDBOX_GO_VERSION,
  sanitizeRequirements,
} from "./plan.js";
import { runProbes } from "./run.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const repoDir = (name: string) => join(ROOT, "fixtures/repos", name, "repo");

function viewOf(dir: string): ProjectView {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [relative(dir, p)];
    });
  const files = new Set(walk(dir));
  return { files, read: (p) => (files.has(p) ? readFileSync(join(dir, p), "utf8") : null) };
}
const memView = (files: Record<string, string>): ProjectView => ({
  files: new Set(Object.keys(files)),
  read: (p) => files[p] ?? null,
});

describe("test output parsing", () => {
  it("node:test TAP", () => {
    const out =
      "TAP version 13\nok 1 - creates a task\nnot ok 2 - marks a task done\n  ---\nok 3 - exports # SKIP\n1..3\n# tests 4\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 0\n";
    expect(parseTestOutput(out)).toEqual({
      runner: "node:test",
      pass: 2,
      fail: 1,
      skip: 1,
      failing: ["marks a task done"],
    });
  });
  it("pytest", () => {
    const out =
      "..F.s\nFAILED tests/test_notes.py::test_search_is_case_insensitive - assert 0 == 1\n1 failed, 2 passed, 1 skipped in 0.31s\n";
    expect(parseTestOutput(out)).toEqual({
      runner: "pytest",
      pass: 2,
      fail: 1,
      skip: 1,
      failing: ["tests/test_notes.py::test_search_is_case_insensitive"],
    });
    expect(parseTestOutput("======= 3 passed, 1 warning in 1.2s =======")?.pass).toBe(3);
  });
  it("vitest, jest and mocha", () => {
    expect(
      parseTestOutput(
        " ✓ a\n × src/a.test.ts > breaks 3ms\n      Tests  1 failed | 2 passed | 1 skipped (4)\n",
      ),
    ).toMatchObject({ runner: "vitest", pass: 2, fail: 1, skip: 1 });
    expect(
      parseTestOutput(
        "  ● Store › marks done\nTests:       1 failed, 1 skipped, 2 passed, 4 total\n",
      ),
    ).toMatchObject({ runner: "jest", fail: 1, skip: 1, pass: 2, failing: ["marks done"] });
    expect(parseTestOutput("  2 passing (10ms)\n  1 failing\n  1 pending\n")).toMatchObject({
      runner: "mocha",
      pass: 2,
      fail: 1,
      skip: 1,
    });
  });
  it("go test -json: top-level tests, subtests rolled up, unbuilt packages as failures", () => {
    const ev = (o: object) => JSON.stringify({ Time: "2026-10-28T00:00:00Z", ...o });
    const out = [
      ev({ Action: "run", Package: "ex/cart", Test: "TestAdd" }),
      ev({ Action: "pass", Package: "ex/cart", Test: "TestAdd/one" }),
      ev({ Action: "pass", Package: "ex/cart", Test: "TestAdd" }),
      ev({ Action: "fail", Package: "ex/cart", Test: "TestTotal" }),
      ev({ Action: "skip", Package: "ex/cart", Test: "TestExport" }),
      ev({ Action: "fail", Package: "ex/cart" }),
      ev({ Action: "output", Package: "ex/api", Output: "FAIL\tex/api [build failed]\n" }),
      ev({ Action: "fail", Package: "ex/api" }),
    ].join("\n");
    expect(parseTestOutput(out)).toEqual({
      runner: "go",
      pass: 1,
      fail: 2,
      skip: 1,
      failing: ["TestTotal"],
    });
  });
  it("returns null when there is no summary (unknown, never passing)", () => {
    expect(parseTestOutput("Segmentation fault")).toBeNull();
  });
  it("extracts diagnostics with file and line, skipping dependencies", () => {
    const out = [
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts:7:1 - error TS2304: Cannot find name 'x'.",
      "node_modules/x/index.d.ts(1,1): error TS1: nope",
      '  File "/work/notes_api/app.py", line 12, in <module>',
      "/home/user/src/c.ts",
      "  4:2  error  'y' is defined but never used  no-unused-vars",
      "./internal/cart/cart.go:12:5: undefined: total",
      "vet: ./cmd/shop/main.go:9:2: fmt.Printf format %d has arg x of wrong type string",
      "/work/.cs-gomod/github.com/x/y@v1.0.0/y.go:3:1: syntax error",
    ].join("\n");
    expect(parseErrorLines(out).map((e) => `${e.file}:${e.line}`)).toEqual([
      "src/a.ts:3",
      "src/b.ts:7",
      "internal/cart/cart.go:12",
      "cmd/shop/main.go:9",
      "notes_api/app.py:12",
    ]);
  });
});

describe("probe planning", () => {
  it("ts-taskboard: npm ci with scripts off, then rebuild, build, tsc, no lint, npm test", () => {
    const p = planProbes(viewOf(repoDir("ts-taskboard")));
    expect(p.packageManager).toBe("npm");
    expect(p.refused).toBeNull();
    expect(p.fetch?.command).toContain("--ignore-scripts");
    expect(
      p.steps.map(
        (s) =>
          `${s.name}:${s.command ? s.command.join(" ") : `[${s.skip?.kind}] ${s.skip?.reason}`}`,
      ),
    ).toEqual([
      "install:npm rebuild",
      "build:npm run --silent build",
      "typecheck:npx --no-install tsc --noEmit -p tsconfig.json",
      "lint:[gap] no lint script in package.json",
      "tests:npm run --silent test",
    ]);
  });
  it("py-notes-api: wheels-only download, offline venv install, no build step, pytest", () => {
    const p = planProbes(viewOf(repoDir("py-notes-api")));
    expect(p.fetch?.command.join(" ")).toContain("--only-binary=:all:");
    expect(p.steps.map((s) => `${s.name}:${s.command ? "run" : s.skip?.kind}`)).toEqual([
      "install:run",
      "build:not_applicable",
      "typecheck:gap",
      "lint:gap",
      "tests:run",
    ]);
  });
  it("refuses lockfile URLs outside the public registry", () => {
    const lock = (resolved: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/x": { version: "1.0.0", resolved } },
      });
    expect(
      checkNpmLockUrls(lock("https://registry.npmjs.org/x/-/x-1.0.0.tgz"), "package-lock.json"),
    ).toBeNull();
    expect(
      checkNpmLockUrls(lock("http://169.254.169.254/latest/meta-data"), "package-lock.json"),
    ).toMatch(/169\.254\.169\.254/);
    expect(checkNpmLockUrls(lock("https://internal.corp/x.tgz"), "package-lock.json")).toMatch(
      /internal\.corp/,
    );
    expect(checkNpmLockUrls(lock("git+ssh://git@github.com/x/y.git"), "package-lock.json")).toMatch(
      /not the public npm registry/,
    );
    const p = planProbes(
      memView({
        "package.json": '{"dependencies":{"x":"1"}}',
        "package-lock.json": lock("http://10.0.0.1/x.tgz"),
      }),
    );
    expect(p.refused).toMatch(/10\.0\.0\.1/);
  });
  it("drops pip options and direct URLs from requirements", () => {
    const s = sanitizeRequirements(
      "--index-url http://internal/simple\n-e .\nfoo==1.0\nbar @ https://evil/bar.whl\nbaz>=2,<3 ; python_version > '3.8'\n--trusted-host internal\n",
    );
    expect(s.text).toBe("foo==1.0\nbaz>=2,<3 ; python_version > '3.8'\n");
    expect(s.dropped).toHaveLength(4);
  });
  it("records gaps instead of guessing when it cannot install", () => {
    const p = planProbes(
      memView({ "package.json": '{"dependencies":{"x":"1"},"scripts":{"test":"jest"}}' }),
    );
    expect(p.steps.every((s) => s.skip?.kind === "gap")).toBe(true);
    expect(planProbes(memView({ "main.go": "" })).ecosystem).toBe("none");
    const disabled = planProbes(
      memView({
        "package.json": "{}",
        "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
        ".npmrc": "registry=http://internal/",
      }),
    );
    expect(disabled.prepare).toContainEqual({ rename: [".npmrc", ".npmrc.codesentra-disabled"] });
  });
});

describe("probe planning for Go, Ruby and JVM projects", () => {
  const goMod = (go: string, requires = true) =>
    `module example.com/shop\n\ngo ${go}\n${requires ? "\nrequire github.com/google/uuid v1.6.0\n" : ""}`;

  it("Go: module-proxy-only download, offline verify, build, vet and go test -json", () => {
    const p = planProbes(memView({ "go.mod": goMod("1.23"), "go.sum": "x" }));
    expect(p.ecosystem).toBe("go");
    const fetch = p.fetch?.command.join(" ") ?? "";
    expect(fetch).toContain("GOPROXY=https://proxy.golang.org ");
    expect(fetch).not.toMatch(/GOPROXY=\S*direct/);
    expect(fetch).toContain("GOSUMDB=sum.golang.org");
    expect(fetch).toContain("GOTOOLCHAIN=local");
    expect(fetch).toContain("go mod download");
    expect(
      p.steps.map(
        (s) => `${s.name}:${s.command ? s.command.join(" ").split(" go ")[1] : s.skip?.kind}`,
      ),
    ).toEqual([
      "install:mod verify",
      "build:build ./...",
      "typecheck:not_applicable",
      "lint:vet ./...",
      "tests:test -json ./...",
    ]);
    for (const st of p.steps.filter((x) => x.command))
      expect(st.command?.join(" ")).toContain("GOPROXY=off");
  });
  it("Go: gaps for a missing go.sum and for a Go newer than the sandbox's", () => {
    const noSum = planProbes(memView({ "go.mod": goMod("1.23") }));
    expect(noSum.fetch).toBeNull();
    expect(noSum.steps.every((s) => s.skip?.kind === "gap")).toBe(true);
    expect(noSum.steps[0]?.skip?.reason).toMatch(/no go\.sum/);
    const newer = planProbes(memView({ "go.mod": goMod("9.0"), "go.sum": "x" }));
    expect(newer.steps[0]?.skip?.reason).toBe(
      `go.mod needs Go 9.0; the sandbox has Go ${SANDBOX_GO_VERSION}`,
    );
    const noDeps = planProbes(memView({ "go.mod": goMod("1.23", false) }));
    expect(noDeps.fetch).toBeNull();
    expect(noDeps.steps[0]?.skip?.kind).toBe("not_applicable");
  });
  it("Ruby and JVM: every step is a gap naming why the download would run code", () => {
    const rb = planProbes(memView({ Gemfile: 'gem "sinatra"', "Gemfile.lock": "" }));
    expect(rb.fetch).toBeNull();
    expect(
      rb.steps.every((s) => s.skip?.kind === "gap" && /Gemfile \(Ruby code\)/.test(s.skip.reason)),
    ).toBe(true);
    for (const f of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
      const j = planProbes(memView({ [f]: "" }));
      expect(
        j.steps.every((s) => /Maven and Gradle run build plugins/.test(s.skip?.reason ?? "")),
        f,
      ).toBe(true);
    }
  });
  it("the sandbox image has the Go version the planner assumes", () => {
    const dockerfile = readFileSync(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../infra/sandbox/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(`FROM golang:${SANDBOX_GO_VERSION}-bookworm AS go`);
  });
});

describe("secrets scan (gitleaks)", () => {
  it.each(loadFixtureRepos().map((r) => [r.expected.name, r] as const))(
    "%s: finds the planted key and never stores it",
    async (_n, repo) => {
      const want = repo.expected.findings.find((f) => f.code === "SECRET_EXPOSED") as unknown as {
        locator: string;
        secretType: string;
        storedPreviewMustNotContain: string;
      };
      const found = await scanSecrets(repo.repoDir);
      const [file, line] = want.locator.split(":");
      const hit = found.find((f) => f.file === file && f.line === Number(line));
      expect(hit?.type).toBe(want.secretType);
      expect(hit?.preview).toContain("•••");
      for (const f of found)
        expect(JSON.stringify(f)).not.toContain(want.storedPreviewMustNotContain);
    },
  );
});

/**
 * The probes against the real fixture repos: dependencies download through the fetch
 * network (SANDBOX_FETCH_* when egress needs a proxy), everything else runs offline.
 */
describe("probes in the sandbox (fixture repos)", () => {
  const IMAGE = process.env.SANDBOX_IMAGE ?? "codesentra/sandbox:test";
  let sbx: Sandbox;
  const scratch: string[] = [];
  beforeAll(async () => {
    if (!process.env.SANDBOX_IMAGE)
      execFileSync("docker", ["build", "-q", "-t", IMAGE, join(ROOT, "infra/sandbox")], {
        stdio: "pipe",
        timeout: 600_000,
      });
    sbx = await createSandbox({
      network: process.env.SANDBOX_FETCH_NETWORK ?? "bridge",
      proxy: process.env.SANDBOX_FETCH_PROXY ?? null,
      caFile: process.env.SANDBOX_FETCH_CA_FILE ?? null,
    });
  }, 660_000);
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it.each(loadFixtureRepos().map((r) => [r.expected.name, r] as const))(
    "%s matches expected.json probes",
    async (_n, repo) => {
      const dir = mkdtempSync(join(tmpdir(), "cs-probe-"));
      scratch.push(dir);
      const run = await runProbes({
        sandbox: sbx,
        image: IMAGE,
        sourceDir: repo.repoDir,
        scratchDir: dir,
        plan: planProbes(viewOf(repo.repoDir)),
      });
      const by = Object.fromEntries(run.results.map((r) => [r.name, r]));
      const ctx = JSON.stringify(
        {
          fetch: run.fetch,
          results: run.results.map((r) => ({ ...r, excerpt: r.excerpt.slice(-800) })),
        },
        null,
        1,
      );
      const ran = repo.expected.probes.tests;
      // Ecosystems whose download would run code fetch nothing and run nothing (ADR 0026).
      expect(run.fetch.status, ctx).toBe(ran ? "pass" : "none");
      expect(by.install?.status, ctx).toBe(repo.expected.probes.install);
      expect(by.build?.status, ctx).toBe(repo.expected.probes.build);
      if (ran) {
        expect(by.tests?.tests, ctx).toMatchObject(ran);
        expect(by.tests?.status).toBe("fail");
      } else expect(by.tests?.status, ctx).toBe("skipped");
      expect(["pass", "not_applicable", "skipped"]).toContain(by.typecheck?.status);
      // The original tree is untouched.
      expect(readdirSync(repo.repoDir)).not.toContain("node_modules");
      expect(readdirSync(repo.repoDir)).not.toContain(".cs-venv");
    },
    15 * 60_000,
  );
});
