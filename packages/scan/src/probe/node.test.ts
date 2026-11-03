import { describe, expect, it } from "vitest";
import { NODE_CACHE, type NodePlan, selectNodeManager } from "./node.js";
import type { ProjectView } from "./plan.js";

const view = (files: Record<string, string>): ProjectView => ({
  files: new Set(Object.keys(files)),
  read: (p) => files[p] ?? null,
});
const PKG = '{"name":"h","version":"1.0.0","dependencies":{"is-number":"7.0.0"}}';
const plan = (files: Record<string, string>) => selectNodeManager(view(files)) as NodePlan;

/** Every command run by the download or install, flattened for assertions. */
const allArgv = (p: NodePlan) => [p.fetch.argv, p.install.argv, p.run("build").argv];

describe("Node package-manager commands (ADR 0030)", () => {
  it("selects the manager by lockfile, never by a packageManager field", () => {
    const pm = '{"packageManager":"pnpm@9.0.0+sha512.deadbeef","dependencies":{"a":"1"}}';
    expect(plan({ "package.json": pm, "package-lock.json": '{"lockfileVersion":3}' }).manager).toBe(
      "npm",
    );
    expect(plan({ "package.json": pm, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }).manager).toBe(
      "pnpm",
    );
    expect(selectNodeManager(view({ "package.json": pm }))).toBeNull();
  });

  it("uses CodeSentra's pinned binaries, never corepack or a project path", () => {
    for (const files of [
      { "package.json": PKG, "package-lock.json": "{}" },
      { "package.json": PKG, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" },
      { "package.json": PKG, "yarn.lock": "# yarn lockfile v1\n" },
      { "package.json": PKG, "yarn.lock": "__metadata:\n  version: 10\n" },
    ] as Record<string, string>[]) {
      const p = plan(files);
      const flat = allArgv(p).flat().join(" ");
      expect(flat).not.toMatch(/corepack/);
      expect(flat).not.toMatch(/\byarn-path\b|yarnPath/);
      if (p.manager !== "npm") expect(allArgv(p).every((a) => a[0] === "node")).toBe(true);
      // Every binary is under the image's pinned directory.
      for (const a of allArgv(p))
        if (a[0] === "node") expect(a[1]).toMatch(/^\/opt\/codesentra\/pm\//);
    }
  });

  it("pins the pnpm release to the lockfile version", () => {
    expect(
      plan({ "package.json": PKG, "pnpm-lock.yaml": "lockfileVersion: 5.4\n" }).fetch.argv[1],
    ).toContain("pnpm-7.33.5");
    expect(
      plan({ "package.json": PKG, "pnpm-lock.yaml": "lockfileVersion: '6.0'\n" }).fetch.argv[1],
    ).toContain("pnpm-8.15.9");
    expect(
      plan({ "package.json": PKG, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }).fetch.argv[1],
    ).toContain("pnpm-10.34.9");
  });

  it("disables scripts and hooks, freezes the lockfile, and downloads from our registry only", () => {
    const npm = plan({ "package.json": PKG, "package-lock.json": "{}" });
    expect(npm.fetch.argv).toContain("--ignore-scripts");
    expect(npm.fetch.argv.join(" ")).toContain("registry=https://registry.npmjs.org");
    expect(npm.fetch.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");

    const pnpm = plan({ "package.json": PKG, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(pnpm.fetch.argv).toContain("--ignore-scripts");
    expect(pnpm.fetch.argv).toContain("--ignore-pnpmfile");
    expect(pnpm.fetch.argv).toContain("--frozen-lockfile");

    const yc = plan({ "package.json": PKG, "yarn.lock": "# yarn lockfile v1\n" });
    expect(yc.fetch.argv).toContain("--ignore-scripts");
    expect(yc.fetch.argv).toContain("--frozen-lockfile");
    expect(yc.fetch.env.YARN_IGNORE_PATH).toBe("1");

    const yb = plan({ "package.json": PKG, "yarn.lock": "__metadata:\n  version: 10\n" });
    expect(yb.fetch.env.YARN_ENABLE_SCRIPTS).toBe("0");
    expect(yb.fetch.env.YARN_PLUGINS).toBe("");
    expect(yb.fetch.env.YARN_ENABLE_IMMUTABLE_INSTALLS).toBe("1");
    expect(yb.fetch.env.YARN_NPM_REGISTRY_SERVER).toBe("https://registry.npmjs.org");
  });

  it("the install reads only the cache with no network; the download fills it", () => {
    for (const files of [
      { "package.json": PKG, "package-lock.json": "{}" },
      { "package.json": PKG, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" },
      { "package.json": PKG, "yarn.lock": "# yarn lockfile v1\n" },
      { "package.json": PKG, "yarn.lock": "__metadata:\n  version: 10\n" },
    ] as Record<string, string>[]) {
      const p = plan(files);
      const fetchStr = `${p.fetch.argv.join(" ")} ${JSON.stringify(p.fetch.env)}`;
      const installStr = `${p.install.argv.join(" ")} ${JSON.stringify(p.install.env)}`;
      expect(fetchStr).toContain(NODE_CACHE);
      expect(installStr).toContain(NODE_CACHE);
      // Offline: either an --offline flag or YARN_ENABLE_NETWORK=0.
      expect(/--offline|"YARN_ENABLE_NETWORK":"0"/.test(installStr)).toBe(true);
      // The download never asks to stay offline.
      expect(fetchStr).not.toContain("--offline");
      expect(fetchStr).not.toContain('"YARN_ENABLE_NETWORK":"0"');
    }
  });
});
