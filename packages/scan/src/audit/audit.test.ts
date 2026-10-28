import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { directOnly, isLockfile, type LockedPackage, parseLockfile } from "./lockfiles.js";
import { affects, auditPackages, type OsvRecord, offlineSource } from "./osv.js";
import { compareFor, compareGem, compareMaven, comparePep440, compareSemver } from "./versions.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const SNAPSHOT = join(ROOT, "fixtures/osv");
const repo = (name: string, path: string) => join(ROOT, "fixtures/repos", name, "repo", path);
const lock = (name: string, path: string) => {
  const p = parseLockfile(path, readFileSync(repo(name, path), "utf8"));
  if (!p) throw new Error(path);
  return p;
};

describe("version ordering", () => {
  it("orders SemVer, including prereleases", () => {
    expect(compareSemver("4.17.15", "4.17.19")).toBeLessThan(0);
    expect(compareSemver("4.17.21", "4.17.19")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareSemver("2", "2.0.0")).toBe(0);
    expect(compareSemver("not-a-version", "1.0.0")).toBeNull();
  });
  it("orders PEP 440, including pre, post and dev releases", () => {
    const ordered = ["1.0.dev1", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1", "1.0.1", "1!0.1"];
    for (let i = 1; i < ordered.length; i++)
      expect(
        comparePep440(ordered[i - 1] as string, ordered[i] as string),
        `${ordered[i - 1]} < ${ordered[i]}`,
      ).toBeLessThan(0);
    expect(comparePep440("3.1.2", "3.1.3")).toBeLessThan(0);
    expect(comparePep440("3.1", "3.1.0")).toBe(0);
  });
});

describe("version ordering for Go, RubyGems and Maven", () => {
  it("orders Go module versions as v-prefixed SemVer, pseudo-versions before releases", () => {
    const go = compareFor("Go");
    expect(go("v1.9.0", "v1.9.1")).toBeLessThan(0);
    expect(go("v0.0.0-20230101000000-abcdef123456", "v0.0.1")).toBeLessThan(0);
    expect(go("v2.1.0+incompatible", "v2.1.0")).toBe(0);
  });
  it("orders RubyGems versions, prereleases first, platforms ignored", () => {
    expect(compareGem("2.2.3", "2.2.3.1")).toBeLessThan(0);
    expect(compareGem("1.0", "1.0.0")).toBe(0);
    expect(compareGem("3.0.0.beta1", "3.0.0")).toBeLessThan(0);
    expect(compareGem("3.0.0.rc1", "3.0.0.beta2")).toBeGreaterThan(0);
    expect(compareGem("1.16.0-x86_64-linux", "1.16.0")).toBe(0);
    expect(compareGem("not a version!", "1")).toBeNull();
  });
  it("orders Maven versions with qualifiers", () => {
    expect(compareMaven("2.13.2", "2.13.2.1")).toBeLessThan(0);
    expect(compareMaven("2.13.4.1", "2.13.4")).toBeGreaterThan(0);
    expect(compareMaven("1.0", "1.0.0")).toBe(0);
    expect(compareMaven("1.0-rc1", "1.0")).toBeLessThan(0);
    expect(compareMaven("1.0-alpha", "1.0-beta")).toBeLessThan(0);
    expect(compareMaven("1.0-SNAPSHOT", "1.0")).toBeLessThan(0);
    expect(compareMaven("1.0.Final", "1.0")).toBe(0);
    expect(compareMaven("1.0-sp1", "1.0")).toBeGreaterThan(0);
    expect(compareMaven("5.3.10", "5.3.9")).toBeGreaterThan(0);
  });
});

describe("Go, RubyGems and Maven lockfiles", () => {
  it("reads go.mod requires, applying replace directives", () => {
    const p = parseLockfile(
      "go.mod",
      [
        "module example.com/shop",
        "go 1.23",
        "require (",
        "\tgithub.com/gin-gonic/gin v1.9.0",
        "\tgolang.org/x/net v0.10.0 // indirect",
        "\texample.com/local v0.0.0",
        ")",
        "replace example.com/local => ../local",
        "replace golang.org/x/net => golang.org/x/net v0.23.0",
      ].join("\n"),
    );
    expect(p?.ecosystem).toBe("Go");
    expect(p?.packages.map((x) => `${x.name}@${x.version} ${x.locator}`)).toEqual([
      "github.com/gin-gonic/gin@v1.9.0 go.mod:4",
      "golang.org/x/net@v0.23.0 go.mod:5",
    ]);
    expect(p?.unpinned.map((u) => u.text)).toEqual([
      "example.com/local (replaced by a local directory)",
    ]);
    expect(p && directOnly(p)).toBe(false);
  });

  it("reads Gemfile.lock GEM specs, not their dependency constraints", () => {
    const p = parseLockfile(
      "Gemfile.lock",
      [
        "GEM",
        "  remote: https://rubygems.org/",
        "  specs:",
        "    rack (2.2.3)",
        "    nokogiri (1.16.0-x86_64-linux)",
        "      racc (~> 1.4)",
        "    sinatra (3.0.5)",
        "      rack (~> 2.2, >= 2.2.4)",
        "",
        "GIT",
        "  remote: https://github.com/x/y.git",
        "  specs:",
        "    y (0.1.0)",
        "",
        "PLATFORMS",
        "  ruby",
      ].join("\n"),
    );
    expect(p?.packages.map((x) => `${x.name}@${x.version} ${x.locator}`)).toEqual([
      "rack@2.2.3 Gemfile.lock:4",
      "nokogiri@1.16.0 Gemfile.lock:5",
      "sinatra@3.0.5 Gemfile.lock:7",
    ]);
    expect(p?.unpinned.map((u) => u.text)).toEqual(["y (git source)"]);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: a Maven property reference
  it("reads pom.xml dependencies, resolving ${properties}, and lists managed ones", () => {
    const p = parseLockfile(
      "pom.xml",
      [
        "<project>",
        "  <properties><jackson.version>2.13.2</jackson.version></properties>",
        "  <dependencies>",
        "    <dependency>",
        "      <groupId>com.fasterxml.jackson.core</groupId>",
        "      <artifactId>jackson-databind</artifactId>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a Maven property reference
        "      <version>${jackson.version}</version>",
        "    </dependency>",
        "    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>",
        "    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version><scope>test</scope></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
    );
    expect(p?.packages.map((x) => `${x.name}@${x.version} ${x.locator} dev=${x.dev}`)).toEqual([
      "com.fasterxml.jackson.core:jackson-databind@2.13.2 pom.xml:4 dev=false",
      "junit:junit@4.12 pom.xml:10 dev=true",
    ]);
    expect(p?.unpinned.map((u) => u.text)).toEqual([
      "org.springframework.boot:spring-boot-starter-web (version set by the parent POM or a BOM)",
    ]);
    expect(p && directOnly(p)).toBe(true);
  });

  it("reads gradle.lockfile and build.gradle", () => {
    const lockP = parseLockfile(
      "gradle.lockfile",
      "# comment\ncom.google.guava:guava:31.0-jre=compileClasspath,runtimeClasspath\njunit:junit:4.12=testCompileClasspath\nempty=\n",
    );
    expect(lockP?.packages.map((x) => `${x.name}@${x.version} dev=${x.dev}`)).toEqual([
      "com.google.guava:guava@31.0-jre dev=false",
      "junit:junit@4.12 dev=true",
    ]);
    const build = parseLockfile(
      "build.gradle",
      "dependencies {\n  implementation 'com.google.guava:guava:31.0-jre'\n  implementation 'org.x:y'\n}\n",
    );
    expect(build?.packages.map((x) => x.name)).toEqual(["com.google.guava:guava"]);
    expect(build?.unpinned.map((u) => u.text)).toEqual(["org.x:y (no fixed version)"]);
  });

  it("recognizes the new lockfile names", () => {
    for (const f of [
      "go.mod",
      "Gemfile.lock",
      "pom.xml",
      "gradle.lockfile",
      "svc/build.gradle.kts",
    ])
      expect(isLockfile(f), f).toBe(true);
    expect(isLockfile("go.sum")).toBe(false);
  });
});

describe("lockfiles", () => {
  it("reads package-lock.json v3 with dev flags", () => {
    const p = lock("ts-taskboard", "package-lock.json");
    expect(p.ecosystem).toBe("npm");
    expect(p.packages.find((x) => x.name === "lodash")).toMatchObject({
      version: "4.17.15",
      dev: false,
      locator: "package-lock.json",
    });
    expect(p.packages.find((x) => x.name === "typescript")?.dev).toBe(true);
    expect(p.packages.find((x) => x.name === "@types/express")).toBeTruthy();
  });
  it("reads pinned requirements with line locators and lists unpinned lines", () => {
    const p = lock("py-notes-api", "requirements.txt");
    expect(p.packages.map((x) => `${x.name}==${x.version}@${x.locator}`)).toEqual([
      "fastapi==0.115.6@requirements.txt:1",
      "jinja2==3.1.2@requirements.txt:2",
      "uvicorn==0.32.1@requirements.txt:3",
    ]);
    const odd = parseLockfile(
      "requirements.txt",
      "-e .\nrequests>=2\nFoo_Bar[x]==1.0 ; python_version>'3'\n--index-url http://internal/\n",
    );
    expect(odd?.packages.map((x) => `${x.name}==${x.version}`)).toEqual(["foo-bar==1.0"]);
    expect(odd?.unpinned.map((x) => x.text)).toEqual([
      "-e .",
      "requests>=2",
      "--index-url http://internal/",
    ]);
  });
  it("reads pnpm, yarn and poetry locks", () => {
    expect(
      parseLockfile(
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\npackages:\n  lodash@4.17.15:\n    resolution: {}\n  '@a/b@1.0.0':\n    x: y\nsnapshots:\n  c@2.0.0: {}\n",
      )?.packages.map((p) => `${p.name}@${p.version}`),
    ).toEqual(["lodash@4.17.15", "@a/b@1.0.0"]);
    expect(
      parseLockfile(
        "yarn.lock",
        '"lodash@^4.17.0", lodash@4:\n  version "4.17.15"\n\n"@a/b@^1":\n  version "1.2.0"\n',
      )?.packages.map((p) => `${p.name}@${p.version}`),
    ).toEqual(["lodash@4.17.15", "@a/b@1.2.0"]);
    expect(
      parseLockfile(
        "poetry.lock",
        '[[package]]\nname = "Jinja2"\nversion = "3.1.2"\n\n[[package]]\nname = "x"\nversion = "1"\n',
      )?.packages.map((p) => `${p.name}@${p.version}`),
    ).toEqual(["jinja2@3.1.2", "x@1"]);
    expect(isLockfile("a/requirements-dev.txt")).toBe(true);
    expect(isLockfile("package.json")).toBe(false);
  });
});

describe("OSV matching", () => {
  const pkg = (version: string): LockedPackage => ({
    ecosystem: "npm",
    name: "x",
    version,
    locator: "l",
    dev: false,
    resolved: null,
  });
  const rec = (events: Record<string, string>[], extra: Partial<OsvRecord> = {}): OsvRecord => ({
    id: "T-1",
    affected: [{ package: { ecosystem: "npm", name: "x" }, ranges: [{ type: "SEMVER", events }] }],
    ...extra,
  });
  it("evaluates introduced/fixed, last_affected and multiple windows", () => {
    const r = rec([
      { introduced: "0" },
      { fixed: "1.2.0" },
      { introduced: "2.0.0" },
      { fixed: "2.0.5" },
    ]);
    expect(affects(r, pkg("1.1.9"))).toBe(true);
    expect(affects(r, pkg("1.2.0"))).toBe(false);
    expect(affects(r, pkg("1.9.0"))).toBe(false);
    expect(affects(r, pkg("2.0.4"))).toBe(true);
    expect(affects(rec([{ introduced: "1.0.0" }, { last_affected: "1.4.0" }]), pkg("1.4.0"))).toBe(
      true,
    );
    expect(affects(rec([{ introduced: "1.0.0" }]), pkg("9.0.0"))).toBe(true);
    expect(
      affects(
        rec([{ introduced: "0" }, { fixed: "1.0.0" }], { withdrawn: "2026-01-01" }),
        pkg("0.1.0"),
      ),
    ).toBe(false);
  });
  it("matches explicit version lists and normalizes PyPI names", () => {
    const r: OsvRecord = {
      id: "P-1",
      affected: [{ package: { ecosystem: "PyPI", name: "Jinja2" }, versions: ["3.1.2"] }],
    };
    expect(
      affects(r, {
        ecosystem: "PyPI",
        name: "jinja2",
        version: "3.1.2",
        locator: "",
        dev: false,
        resolved: null,
      }),
    ).toBe(true);
    expect(
      affects(r, {
        ecosystem: "PyPI",
        name: "jinja2",
        version: "3.1.3",
        locator: "",
        dev: false,
        resolved: null,
      }),
    ).toBe(false);
  });
});

describe("audit against the offline OSV snapshot (real advisories)", () => {
  it("flags lodash@4.17.15 with GHSA-p6mc-m468-83gw, high, and nothing for the fixed version", async () => {
    const src = await offlineSource(SNAPSHOT);
    const r = await auditPackages(src, lock("ts-taskboard", "package-lock.json").packages);
    const lodash = r.vulnerable.find((v) => v.pkg.name === "lodash");
    expect(lodash?.advisories.map((a) => a.id)).toContain("GHSA-p6mc-m468-83gw");
    expect(lodash?.advisories.find((a) => a.id === "GHSA-p6mc-m468-83gw")?.severity).toBe("high");
    expect(r.notChecked).toEqual([]);
    const fixed = await auditPackages(src, [
      {
        ecosystem: "npm",
        name: "lodash",
        version: "99.0.0",
        locator: "x",
        dev: false,
        resolved: null,
      },
    ]);
    expect(fixed.vulnerable).toEqual([]);
  });

  it("flags jinja2==3.1.2, merging GHSA and PYSEC aliases into one advisory each", async () => {
    const src = await offlineSource(SNAPSHOT);
    const r = await auditPackages(src, lock("py-notes-api", "requirements.txt").packages);
    const jinja = r.vulnerable.find((v) => v.pkg.name === "jinja2");
    expect(jinja?.pkg.locator).toBe("requirements.txt:2");
    const ids = jinja?.advisories.map((a) => a.id) ?? [];
    expect(ids).toContain("GHSA-h5c8-rqwp-cp95");
    expect(ids.some((i) => i.startsWith("PYSEC-"))).toBe(false);
    expect(jinja?.advisories.find((a) => a.id === "GHSA-h5c8-rqwp-cp95")?.fixedVersions).toContain(
      "3.1.3",
    );
  });

  it("reports packages the snapshot does not cover as not checked, never as clean", async () => {
    const src = await offlineSource(SNAPSHOT);
    const r = await auditPackages(src, [
      {
        ecosystem: "npm",
        name: "left-pad",
        version: "1.0.0",
        locator: "x",
        dev: false,
        resolved: null,
      },
    ]);
    expect(r.vulnerable).toEqual([]);
    expect(r.checked).toBe(0);
    expect(r.notChecked[0]?.reason).toMatch(/no data for left-pad/);
  });
});
