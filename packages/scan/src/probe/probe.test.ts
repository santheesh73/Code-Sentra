import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
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
  externalParents,
  lockedComposer,
  lockedGems,
  type ProjectView,
  planProbes,
  pomExtensions,
  SANDBOX_COMPOSER_VERSION,
  SANDBOX_GO_VERSION,
  SANDBOX_JAVA_VERSION,
  SANDBOX_MAVEN_VERSION,
  SANDBOX_PHP_VERSION,
  SANDBOX_RUBY_VERSION,
  SANDBOX_RUST_VERSION,
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
  it("RSpec (failing examples by file:line) and Minitest", () => {
    expect(
      parseTestOutput(
        "4 examples, 1 failure, 1 pending\n\nFailed examples:\n\nrspec ./spec/store_spec.rb:20 # Store searches note bodies\n",
      ),
    ).toEqual({ runner: "rspec", pass: 2, fail: 1, skip: 1, failing: ["spec/store_spec.rb:20"] });
    expect(
      parseTestOutput(
        "  1) Failure:\nStoreTest#test_search [test/store_test.rb:9]:\nExpected 1\n\n5 runs, 7 assertions, 1 failures, 0 errors, 1 skips\n",
      ),
    ).toEqual({ runner: "minitest", pass: 3, fail: 1, skip: 1, failing: ["test_search"] });
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
  const lock = (extra = "") =>
    [
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    rack (2.2.3)",
      "    nokogiri (1.16.0-x86_64-linux)",
      "      racc (~> 1.4)",
      "    rspec-core (3.13.6)",
      "",
      extra,
      "CHECKSUMS",
      `  rack (2.2.3) sha256=${"a".repeat(64)}`,
      "  nokogiri (1.16.0-x86_64-linux)",
      "",
    ].join("\n");

  it("Ruby: the lockfile's exact gems from rubygems.org, checksums where it has them", () => {
    expect(lockedGems(lock())).toEqual({
      gems: [
        { name: "rack", version: "2.2.3", sha256: "a".repeat(64) },
        { name: "nokogiri", version: "1.16.0-x86_64-linux", sha256: null },
        { name: "rspec-core", version: "3.13.6", sha256: null },
      ],
    });
    const p = planProbes(
      memView({ Gemfile: 'gem "rack"', "Gemfile.lock": lock(), ".bundle/config": "" }),
    );
    expect(p.ecosystem).toBe("ruby");
    // Our script, run isolated; the Gemfile is never read by the download.
    expect(p.fetch?.command).toEqual(["python", "-I", ".cs-gems/fetch.py"]);
    expect(p.fetch?.reason).toMatch(/1 checked against the lockfile's sha256/);
    const list = p.prepare.find((x) => x.write?.[0] === ".cs-gems/list.txt")?.write?.[1];
    expect(list).toBe(
      `rack 2.2.3 ${"a".repeat(64)}\nnokogiri 1.16.0-x86_64-linux -\nrspec-core 3.13.6 -\n`,
    );
    expect(p.prepare).toContainEqual({
      rename: [".bundle/config", ".bundle/config.codesentra-disabled"],
    });
    expect(
      p.steps.map(
        (s) => `${s.name}:${s.command ? s.command.join(" ").split(" bundle ")[1] : s.skip?.kind}`,
      ),
    ).toEqual([
      "install:install --local",
      "build:not_applicable",
      "typecheck:gap",
      "lint:gap",
      "tests:exec rspec",
    ]);
    expect(p.steps[0]?.command?.join(" ")).toContain(
      "BUNDLE_CACHE_PATH=.cs-gems BUNDLE_FROZEN=true",
    );
  });
  it("Ruby: refuses git sources, other gem servers and odd names; gaps without a lockfile", () => {
    expect(
      lockedGems(lock("GIT\n  remote: https://github.com/x/y.git\n  specs:\n    y (0.1.0)\n")),
    ).toEqual({ refused: "y comes from a git repository (https://github.com/x/y.git)" });
    expect(lockedGems(lock().replace("https://rubygems.org/", "https://gems.internal/"))).toEqual({
      refused: "rack comes from https://gems.internal/, not rubygems.org",
    });
    expect(lockedGems(lock().replace("rack (2.2.3)", "../x (1)"))).toMatchObject({
      refused: expect.stringContaining("not a plain gem name"),
    });
    const refused = planProbes(
      memView({
        Gemfile: "",
        "Gemfile.lock": lock().replace("https://rubygems.org/", "http://10.0.0.1/"),
      }),
    );
    expect(refused.refused).toMatch(/10\.0\.0\.1/);
    const noLock = planProbes(memView({ Gemfile: 'gem "rack"' }));
    expect(noLock.fetch).toBeNull();
    expect(noLock.steps[0]?.skip?.reason).toMatch(/no Gemfile\.lock/);
  });
  it("Maven: Central-only download with the pinned plugin, then offline package and test", () => {
    const p = planProbes(memView({ "pom.xml": "<project/>", ".mvn/jvm.config": "-Xmx8g" }));
    expect(p.ecosystem).toBe("maven");
    expect(p.refused).toBeNull();
    expect(p.fetch?.command).toEqual(["sh", ".cs-m2/fetch.sh"]);
    const script = p.prepare.find((x) => x.write?.[0] === ".cs-m2/fetch.sh")?.write?.[1] ?? "";
    expect(script).toContain(
      "<mirrorOf>*</mirrorOf><url>https://repo.maven.apache.org/maven2</url>",
    );
    expect(script).toContain("maven-dependency-plugin:3.11.0:go-offline");
    expect(script).toMatch(/command mvn -B -q -s \$M2\/settings\.xml -C /);
    expect(p.prepare).toContainEqual({
      rename: [".mvn/jvm.config", ".mvn/jvm.config.codesentra-disabled"],
    });
    expect(
      p.steps.map(
        (s) =>
          `${s.name}:${s.command ? s.command.join(" ").split("settings.xml ")[1] : s.skip?.kind}`,
      ),
    ).toEqual([
      "install:-q org.apache.maven.plugins:maven-dependency-plugin:3.11.0:resolve",
      "build:-DskipTests package",
      "typecheck:not_applicable",
      "lint:gap",
      "tests:test",
    ]);
    for (const s of p.steps.filter((x) => x.command))
      expect(s.command?.join(" ")).toContain(" -o ");
  });
  it("Maven: refuses build extensions, which run when Maven starts; Gradle stays a gap", () => {
    expect(
      planProbes(memView({ "pom.xml": "<project/>", ".mvn/extensions.xml": "<extensions/>" }))
        .refused,
    ).toMatch(/core extensions/);
    const ext =
      "<project><build><extensions><extension><groupId>x</groupId></extension></extensions></build></project>";
    expect(planProbes(memView({ "pom.xml": ext })).refused).toMatch(
      /pom\.xml declares build extensions/,
    );
    expect(
      planProbes(
        memView({
          "pom.xml": "<project/>",
          "svc/pom.xml":
            "<project><build><plugins><plugin><artifactId>x</artifactId><extensions>true</extensions></plugin></plugins></build></project>",
        }),
      ).refused,
    ).toMatch(/svc\/pom\.xml/);
    // A commented-out extension is not one.
    expect(planProbes(memView({ "pom.xml": `<!-- ${ext} --><project/>` })).refused).toBeNull();
    for (const f of ["build.gradle", "build.gradle.kts"])
      expect(
        planProbes(memView({ [f]: "" })).steps.every((s) =>
          /Gradle evaluates the build script/.test(s.skip?.reason ?? ""),
        ),
        f,
      ).toBe(true);
  });
  it("Maven: build extensions count as Maven loads them (used plugins, activated profiles)", () => {
    const managed =
      "<project><build><pluginManagement><plugins><plugin><groupId>org.graalvm.buildtools</groupId><artifactId>native-maven-plugin</artifactId><extensions>true</extensions></plugin></plugins></pluginManagement></build></project>";
    const uses =
      "<project><build><plugins><plugin><groupId>org.graalvm.buildtools</groupId><artifactId>native-maven-plugin</artifactId></plugin></plugins></build></project>";
    // Spring Boot's parent manages one; it loads only where a build uses the plugin.
    expect(pomExtensions([{ name: "parent", xml: managed }])).toBeNull();
    expect(
      pomExtensions([
        { name: "parent", xml: managed },
        { name: "pom.xml", xml: uses },
      ]),
    ).toBe("parent");
    const inProfile = (activation: string) =>
      `<project><profiles><profile><id>p</id>${activation}<build><extensions><extension><groupId>x</groupId></extension></extensions></build></profile></profiles></project>`;
    // We never pass -P: only a profile that can activate on its own counts.
    expect(pomExtensions([{ name: "a", xml: inProfile("") }])).toBeNull();
    expect(
      pomExtensions([{ name: "a", xml: inProfile("<activation><jdk>[17,)</jdk></activation>") }]),
    ).toBe("a");
  });
  it("Maven: parent POMs from Central are checked for build extensions before Maven starts", async () => {
    const root = `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent>
      <groupId>com.x</groupId><artifactId>root</artifactId><version>1.0</version></project>`;
    const svc = `<project><parent><groupId>com.x</groupId><artifactId>root</artifactId><version>1.0</version></parent><artifactId>svc</artifactId></project>`;
    const view = memView({ "pom.xml": root, "svc/pom.xml": svc });
    // The module's parent is in the tree; only the Spring Boot parent comes from Central.
    expect(externalParents(view)).toEqual({
      parents: ["org.springframework.boot spring-boot-starter-parent 3.3.4"],
    });
    const p = planProbes(view);
    expect(p.refused).toBeNull();
    expect(p.prepare).toContainEqual({
      write: [".cs-m2/parents.txt", "org.springframework.boot spring-boot-starter-parent 3.3.4\n"],
    });
    const script = p.prepare.find((x) => x.write?.[0] === ".cs-m2/fetch.sh")?.write?.[1] ?? "";
    expect(script.indexOf("python -I $M2/parents.py")).toBeLessThan(script.indexOf("mvn "));
    expect(p.fetch?.reason).toMatch(
      /after checking the parent POM chain of org.springframework.boot:spring-boot-starter-parent:3.3.4/,
    );
    expect(
      planProbes(
        memView({
          "pom.xml":
            "<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>${revision}</version></parent></project>",
        }),
      ).refused,
    ).toMatch(/parent of pom.xml is not named by a plain groupId/);

    // The check itself, against a stand-in for Maven Central.
    const py = p.prepare.find((x) => x.write?.[0] === ".cs-m2/parents.py")?.write?.[1] ?? "";
    const poms: Record<string, string> = {
      "a/b/p1/1/p1-1.pom":
        "<project><parent><groupId>a.b</groupId><artifactId>p2</artifactId><version>2</version></parent></project>",
      "a/b/p2/2/p2-2.pom": "<project><!-- <extensions>true</extensions> --></project>",
      "a/b/bad/1/bad-1.pom":
        "<project><parent><groupId>a.b</groupId><artifactId>ext</artifactId><version>1</version></parent></project>",
      "a/b/ext/1/ext-1.pom":
        "<project><build><plugins><plugin><extensions>true</extensions></plugin></plugins></build></project>",
      "a/b/tampered/1/tampered-1.pom": "<project/>",
      "a/b/managed/1/managed-1.pom":
        "<project><build><pluginManagement><plugins><plugin><groupId>g</groupId><artifactId>uses</artifactId><extensions>true</extensions></plugin></plugins></pluginManagement></build></project>",
    };
    const server = createServer((req, res) => {
      const path = (req.url ?? "").replace(/^\/maven2\//, "");
      const pom = poms[path.replace(/\.sha1$/, "")];
      if (pom === undefined) return res.writeHead(404).end();
      const sum = path.includes("tampered")
        ? "0".repeat(40)
        : createHash("sha1").update(pom).digest("hex");
      res.end(path.endsWith(".sha1") ? sum : pom);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    // The project's own POM uses the plugin that a.b:managed:1 marks as an extension.
    const uses =
      "<project><build><plugins><plugin><groupId>g</groupId><artifactId>uses</artifactId></plugin></plugins></build></project>";
    const run = (parents: string) => {
      const dir = mkdtempSync(join(tmpdir(), "cs-parents-"));
      mkdirSync(join(dir, ".cs-m2"));
      writeFileSync(join(dir, ".cs-m2/parents.txt"), parents);
      writeFileSync(join(dir, "pom.xml"), uses);
      writeFileSync(join(dir, ".cs-m2/poms.txt"), "pom.xml\n");
      writeFileSync(
        join(dir, ".cs-m2/parents.py"),
        py.replace("https://repo.maven.apache.org/maven2", `http://127.0.0.1:${port}/maven2`),
      );
      return new Promise<{ code: number | null; out: string }>((resolve) => {
        execFile("python3", ["-I", ".cs-m2/parents.py"], { cwd: dir }, (err, stdout, stderr) =>
          resolve({
            code: err ? ((err as { code?: number }).code ?? 1) : 0,
            out: `${stdout}${stderr}`,
          }),
        );
      });
    };
    try {
      expect(await run("a.b p1 1\n")).toMatchObject({
        code: 0,
        out: expect.stringMatching(/checked 2 parent POMs/),
      });
      const bad = await run("a.b bad 1\n");
      expect(bad.code).toBe(3);
      expect(bad.out).toMatch(
        /^codesentra-refused: the parent POM a.b:ext:1 declares build extensions/m,
      );
      const managedUsed = await run("a.b managed 1\n");
      expect(managedUsed.code).toBe(3);
      expect(managedUsed.out).toMatch(/codesentra-refused: the parent POM a.b:managed:1 declares/);
      const tampered = await run("a.b tampered 1\n");
      expect(tampered.code).not.toBe(0);
      expect(tampered.out).toMatch(/does not match its checksum/);
      expect(tampered.out).not.toMatch(/codesentra-refused/);
    } finally {
      server.close();
    }
  });
  it("a download script's refusal is reported as not downloaded, not as a failure", async () => {
    const calls: string[] = [];
    const sandbox: Sandbox = {
      runtime: "runc",
      async run(o) {
        calls.push(o.network ?? "none");
        return {
          exitCode: 3,
          stdout: "codesentra-refused: the parent POM a:b:1 declares build extensions\n",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          truncated: false,
          runtime: "runc",
          network: "fetch",
        };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "cs-refuse-"));
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "pom.xml"), "<project/>");
    const run = await runProbes({
      sandbox,
      image: "x",
      sourceDir: src,
      scratchDir: dir,
      plan: planProbes(memView({ "pom.xml": "<project/>" })),
    });
    rmSync(dir, { recursive: true, force: true });
    // Nothing ran after the refusal but the cleanup that opens up the scratch copy.
    expect(calls).toEqual(["fetch", "none"]);
    expect(run.fetch).toMatchObject({
      status: "refused",
      reason: "not downloaded: the parent POM a:b:1 declares build extensions",
    });
    expect(run.results.find((r) => r.name === "install")).toMatchObject({
      status: "skipped",
      reason:
        "dependencies were not installed: not downloaded: the parent POM a:b:1 declares build extensions",
    });
  });
  it("Maven Surefire output and javac diagnostics", () => {
    const out = [
      "[ERROR] /work/src/main/java/com/x/A.java:[12,5] cannot find symbol",
      "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 1, Time elapsed: 0.07 s <<< FAILURE! -- in com.x.OrderControllerTest",
      "[ERROR] Failures: ",
      "[ERROR]   OrderControllerTest.appliesDiscount:17 expected: <600> but was: <1200>",
      "[INFO] ",
      "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 1",
      "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0",
    ].join("\n");
    expect(parseTestOutput(out)).toEqual({
      runner: "surefire",
      pass: 3,
      fail: 1,
      skip: 1,
      failing: ["appliesDiscount"],
    });
    expect(parseErrorLines(out).map((e) => `${e.file}:${e.line}`)).toEqual([
      "src/main/java/com/x/A.java:12",
    ]);
  });
  it("the sandbox image has the Go version the planner assumes", () => {
    const dockerfile = readFileSync(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../infra/sandbox/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(`FROM golang:${SANDBOX_GO_VERSION}-bookworm AS go`);
    expect(dockerfile).toContain(`FROM ruby:${SANDBOX_RUBY_VERSION}-slim-bookworm AS ruby`);
    expect(dockerfile).toContain(
      `FROM maven:${SANDBOX_MAVEN_VERSION}-eclipse-temurin-${SANDBOX_JAVA_VERSION} AS maven`,
    );
    expect(dockerfile).toContain(`FROM rust:${SANDBOX_RUST_VERSION}-slim-bookworm AS rust`);
    expect(dockerfile).toContain(
      `/usr/local/rustup/toolchains/${SANDBOX_RUST_VERSION}-x86_64-unknown-linux-gnu /opt/rust`,
    );
    expect(dockerfile).toContain(`FROM php:${SANDBOX_PHP_VERSION}-cli-bookworm AS php`);
    expect(dockerfile).toContain(`FROM composer:${SANDBOX_COMPOSER_VERSION} AS composer`);
  });
});

describe("probe planning for Rust and PHP projects", () => {
  const cargoLock = (extra = "") =>
    [
      "version = 4",
      "",
      "[[package]]",
      'name = "app"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "smallvec"',
      'version = "1.6.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'checksum = "fe0f37c9e8f3c5a4a66ad655a93c74daac4ad00f441b5ff43e3b6ac2a22a0539"',
      extra,
    ].join("\n");

  it("Rust: cargo fetch from crates.io, then offline metadata, build, clippy and cargo test", () => {
    const p = planProbes(
      memView({
        "Cargo.toml": '[package]\nname = "app"',
        "Cargo.lock": cargoLock(),
        ".cargo/config.toml": '[build]\nrustc-wrapper = "./evil"',
      }),
    );
    expect(p.ecosystem).toBe("rust");
    expect(p.refused).toBeNull();
    expect(p.fetch?.command).toEqual(["sh", ".cs-cargo/fetch.sh"]);
    expect(p.fetch?.reason).toMatch(/the 1 crates Cargo.lock pins, from crates.io only/);
    const script = p.prepare.find((x) => x.write?.[0] === ".cs-cargo/fetch.sh")?.write?.[1];
    expect(script).toMatch(/cargo fetch --locked/);
    expect(script).toMatch(
      /CARGO_HOME=\/work\/.cs-cargo RUSTC=\/opt\/rust\/bin\/rustc RUSTC_WRAPPER= /,
    );
    // The project's cargo config (wrappers, linkers, registries) is set aside.
    expect(p.prepare).toContainEqual({
      rename: [".cargo/config.toml", ".cargo/config.toml.codesentra-disabled"],
    });
    expect(
      p.steps.map(
        (s) => `${s.name}:${s.command ? s.command.join(" ").split(" cargo ")[1] : s.skip?.kind}`,
      ),
    ).toEqual([
      "install:metadata --frozen --format-version 1 --quiet >/dev/null",
      "build:build --frozen",
      "typecheck:not_applicable",
      "lint:clippy --frozen --all-targets -- -D warnings",
      "tests:test --frozen --no-fail-fast",
    ]);
    expect(p.steps[0]?.command?.join(" ")).toMatch(/CARGO_NET_OFFLINE=true/);
  });

  it("Rust: refuses git sources; gaps without a Cargo.lock; newer-Rust failures are gaps", () => {
    const git = planProbes(
      memView({
        "Cargo.toml": "",
        "Cargo.lock": cargoLock(
          '\n[[package]]\nname = "forked"\nversion = "0.2.0"\nsource = "git+https://example.com/forked#abc"\n',
        ),
      }),
    );
    expect(git.refused).toBe("not downloaded: forked 0.2.0 comes from a git source, not crates.io");
    const none = planProbes(memView({ "Cargo.toml": "" }));
    expect(none.fetch).toBeNull();
    expect(none.steps.map((s) => s.skip?.reason)).toEqual([
      "no Cargo.lock, so crates were not downloaded (installs must be reproducible)",
      "crates were not downloaded",
      "crates were not downloaded",
      "crates were not downloaded",
      "crates were not downloaded",
    ]);
    const build = planProbes(memView({ "Cargo.toml": "", "Cargo.lock": cargoLock() })).steps[1];
    expect(
      build?.gapWhen?.find((g) =>
        g.pattern.test(
          "package `x v1.0.0` cannot be built because it requires rustc 1.120 or newer",
        ),
      )?.reason,
    ).toBe(`a crate needs a newer Rust than the sandbox's ${SANDBOX_RUST_VERSION}`);
  });

  const pkg = (name: string, url: string, extra: Record<string, unknown> = {}) => ({
    name,
    version: "1.0.0",
    dist: { type: "zip", url, reference: "a".repeat(40), shasum: "" },
    ...extra,
  });
  const composerLock = (packages: unknown[], dev: unknown[] = []) =>
    JSON.stringify({ packages, "packages-dev": dev });

  it("PHP: each locked GitHub commit zip from codeload, then offline autoload, php -l and PHPUnit", () => {
    const sha = "b".repeat(40);
    const lock = composerLock(
      [
        pkg("slim/slim", `https://api.github.com/repos/slimphp/Slim/zipball/${"a".repeat(40)}`),
        { name: "psr/meta", version: "1.0.0", type: "metapackage" },
      ],
      [
        pkg(
          "phpunit/phpunit",
          `https://codeload.github.com/sebastianbergmann/phpunit/legacy.zip/${sha}`,
          {
            bin: ["phpunit"],
            dist: {
              type: "zip",
              url: `https://codeload.github.com/sebastianbergmann/phpunit/legacy.zip/${sha}`,
              shasum: "c".repeat(40),
            },
          },
        ),
      ],
    );
    const locked = lockedComposer(lock);
    if ("refused" in locked) throw new Error(locked.refused);
    expect(locked.packages.map((x) => `${x.name} ${x.url} ${x.sha1 ?? "-"} dev=${x.dev}`)).toEqual([
      `slim/slim https://codeload.github.com/slimphp/Slim/legacy.zip/${"a".repeat(40)} - dev=false`,
      `phpunit/phpunit https://codeload.github.com/sebastianbergmann/phpunit/legacy.zip/${sha} ${"c".repeat(40)} dev=true`,
    ]);
    const p = planProbes(
      memView({
        "composer.json": "{}",
        "composer.lock": lock,
        "phpunit.xml.dist": "<phpunit/>",
        "auth.json": "{}",
      }),
    );
    expect(p.ecosystem).toBe("php");
    // Our script, run isolated; Composer does not run during the download.
    expect(p.fetch?.command).toEqual(["python", "-I", ".cs-composer/fetch.py"]);
    expect(p.fetch?.reason).toMatch(
      /the 2 package zips composer.lock pins.*1 checked against the lockfile's sha1/,
    );
    const installed = JSON.parse(
      p.prepare.find((x) => x.write?.[0] === ".cs-composer/installed.json")?.write?.[1] ?? "",
    );
    expect(installed["dev-package-names"]).toEqual(["phpunit/phpunit"]);
    expect(installed.packages.map((x: { "install-path": string }) => x["install-path"])).toEqual([
      "../slim/slim",
      "../phpunit/phpunit",
    ]);
    expect(p.prepare).toContainEqual({ rename: ["auth.json", "auth.json.codesentra-disabled"] });
    expect(
      p.steps.map((s) =>
        s.command
          ? s.command[2]?.replace(/^COMPOSER\S+ (COMPOSER\S+ )*/, "").slice(0, 40)
          : s.skip?.reason,
      ),
    ).toEqual([
      "composer dump-autoload --no-scripts --no",
      "find . -name '*.php' -not -path './vendo",
      "no type checker (PHPStan or Psalm, with its config file) in composer.lock",
      "no linter (PHP-CS-Fixer, PHP_CodeSniffer) in composer.lock",
      "php vendor/phpunit/phpunit/phpunit --col",
    ]);
    expect(p.steps[0]?.command?.[2]).toMatch(/COMPOSER_DISABLE_NETWORK=1/);
  });

  it("PHP: refuses other hosts, source-only and odd names; gaps without a lockfile", () => {
    const refused = (packages: unknown[]) => {
      const r = lockedComposer(composerLock(packages));
      return "refused" in r ? r.refused : null;
    };
    expect(refused([pkg("acme/x", "https://packages.internal/acme/x.zip")])).toBe(
      "acme/x would be downloaded from https://packages.internal; only zips of a locked commit from GitHub or GitLab.com are downloaded (other hosts and private repositories are not)",
    );
    expect(
      refused([pkg("acme/x", `http://api.github.com/repos/a/x/zipball/${"a".repeat(40)}`)]),
    ).toMatch(/would be downloaded from http:\/\/api.github.com/);
    expect(refused([pkg("acme/x", "https://api.github.com/repos/a/x/zipball/main")])).toMatch(
      /only zips of a locked commit/,
    );
    // GitLab.com archives pinned to a commit are downloaded as they are; a branch is not.
    const gl = `https://gitlab.com/api/v4/projects/jdslv%2Fatoum-report-cobertura/repository/archive.zip?sha=${"2".repeat(40)}`;
    const locked = lockedComposer(composerLock([pkg("jdslv/atoum-report-cobertura", gl)]));
    expect("packages" in locked && locked.packages[0]?.url).toBe(gl);
    expect(refused([pkg("acme/x", gl.replace(/sha=2+/, "sha=main"))])).toMatch(/only zips/);
    expect(refused([pkg("acme/x", gl.replace("gitlab.com", "gitlab.example.com"))])).toMatch(
      /from https:\/\/gitlab.example.com;/,
    );
    expect(refused([{ name: "acme/x", version: "1.0", source: { type: "git" } }])).toBe(
      "acme/x has no zip download in composer.lock (source only)",
    );
    expect(
      refused([pkg("../evil", `https://codeload.github.com/a/b/legacy.zip/${"a".repeat(40)}`)]),
    ).toBe('the lockfile entry "../evil" is not a plain package name');
    const none = planProbes(
      memView({ "composer.json": JSON.stringify({ require: { "slim/slim": "^4" } }) }),
    );
    expect(none.steps[0]?.skip?.reason).toBe(
      "no composer.lock, so packages were not installed (installs must be reproducible)",
    );
    // No packages at all: nothing to download, the offline steps still run.
    const bare = planProbes(
      memView({ "composer.json": JSON.stringify({ require: { php: "^8.2" } }) }),
    );
    expect(bare.fetch).toBeNull();
    expect(bare.steps[0]?.command).not.toBeNull();
  });

  it("cargo test, PHPUnit and Pest output; rustc and php -l diagnostics", () => {
    const cargo = [
      "running 0 tests",
      "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
      "running 4 tests",
      "test exports_a_note_as_markdown ... ignored, export is not built yet",
      "test adds_a_note ... ok",
      "test tests::searches_note_bodies ... FAILED",
      "test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    ].join("\n");
    expect(parseTestOutput(cargo)).toEqual({
      runner: "cargo",
      pass: 2,
      fail: 1,
      skip: 1,
      failing: ["tests::searches_note_bodies"],
    });
    const phpunit = [
      "PHPUnit 11.5.57 by Sebastian Bergmann and contributors.",
      "",
      "..SF                                                                4 / 4 (100%)",
      "",
      "There was 1 failure:",
      "",
      "1) Tests\\StoreTest::testSearchesNoteBodies",
      "Failed asserting that actual size 0 matches expected size 1.",
      "",
      "/work/tests/StoreTest.php:35",
      "",
      "--",
      "",
      "There was 1 skipped test:",
      "",
      "1) Tests\\StoreTest::testExportsANoteAsMarkdown",
      "export is not built yet",
      "",
      "FAILURES!",
      "Tests: 4, Assertions: 3, Failures: 1, Skipped: 1.",
    ].join("\n");
    expect(parseTestOutput(phpunit)).toEqual({
      runner: "phpunit",
      pass: 2,
      fail: 1,
      skip: 1,
      failing: ["Tests\\StoreTest::testSearchesNoteBodies"],
    });
    expect(parseTestOutput("OK (3 tests, 5 assertions)")).toMatchObject({
      runner: "phpunit",
      pass: 3,
      fail: 0,
    });
    expect(
      parseTestOutput(
        "   FAILED  Tests\\Feature\\NotesTest > searches note bodies\n\n  Tests:    1 failed, 1 skipped, 2 passed (4 assertions)",
      ),
    ).toEqual({ runner: "pest", pass: 2, fail: 1, skip: 1, failing: ["searches note bodies"] });
    expect(
      parseErrorLines(
        [
          "error[E0432]: unresolved import `axum::extract::Query`",
          "  --> src/lib.rs:7:27",
          "error[E0308]: mismatched types",
          "   --> /work/.cs-cargo/registry/src/x/lib.rs:3:1",
          'Parse error: syntax error, unexpected token "{" in ./src/Broken.php on line 2',
          "PHP Fatal error:  Uncaught Error in vendor/slim/slim/Slim/App.php on line 9",
        ].join("\n"),
      ),
    ).toEqual([
      { file: "src/lib.rs", line: 7, message: "unresolved import `axum::extract::Query`" },
      { file: "src/Broken.php", line: 2, message: 'syntax error, unexpected token "{"' },
    ]);
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
