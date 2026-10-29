import type { ProjectView } from "./plan.js";

/**
 * Commands for Node dependency work (ADR 0030). The download runs CodeSentra's own pinned
 * package-manager binary, baked into the sandbox image, never Corepack and never a binary a
 * project's `packageManager` field, `.yarnrc` `yarn-path` or `.yarn/releases` would choose.
 * Every command takes its configuration from flags and the returned environment only, with
 * install scripts and package-manager hooks disabled and the lockfile frozen. The download
 * populates a cache; the later install, in the no-network sandbox, reads only that cache.
 */

/** The pinned binaries in the sandbox image (infra/sandbox/Dockerfile). */
const PM = "/opt/codesentra/pm";
const PNPM: Record<string, string> = {
  "7": `${PM}/pnpm-7.33.5/bin/pnpm.cjs`,
  "8": `${PM}/pnpm-8.15.9/bin/pnpm.cjs`,
  "10": `${PM}/pnpm-10.34.9/bin/pnpm.cjs`,
};
const YARN_CLASSIC = `${PM}/yarn-1.22.22/bin/yarn.js`;
const YARN_BERRY = `${PM}/yarn-4.18.1/bin/yarn.js`;

const REGISTRY = "https://registry.npmjs.org";
/** The download cache, shared from the fetch directory into the install sandbox. */
export const NODE_CACHE = "/work/.cs-pm-cache";

export type NodeManager = "npm" | "pnpm" | "yarn" | "yarn-berry";

export interface NodePlan {
  manager: NodeManager;
  /** The lockfile the download reads, at the project root. */
  lockfile: string;
  fetch: { argv: string[]; env: Record<string, string> };
  install: { argv: string[]; env: Record<string, string> };
  /** Runs a package.json script offline (build, test, …). */
  run: (script: string) => { argv: string[]; env: Record<string, string> };
}

/** The pnpm release that reads a given `lockfileVersion` (5.x, 6.x, 9.x). */
function pnpmFor(lockText: string): string {
  const v = /^lockfileVersion:\s*['"]?(\d+)/m.exec(lockText)?.[1];
  const major = Number(v ?? "9");
  if (major >= 9) return PNPM["10"] as string;
  if (major >= 6) return PNPM["8"] as string;
  return PNPM["7"] as string;
}

/** Whether a yarn.lock was written by Yarn 2+ (Berry), which keeps a `__metadata` block. */
const isBerry = (lockText: string) => /^__metadata:\s*$/m.test(lockText);

/** The Node package manager for a project, by the lockfile present, or null when none is. */
export function selectNodeManager(view: ProjectView): NodePlan | null {
  if (view.files.has("package-lock.json") || view.files.has("npm-shrinkwrap.json"))
    return npmPlan(
      view.files.has("package-lock.json") ? "package-lock.json" : "npm-shrinkwrap.json",
    );
  if (view.files.has("pnpm-lock.yaml")) return pnpmPlan(pnpmFor(view.read("pnpm-lock.yaml") ?? ""));
  if (view.files.has("yarn.lock"))
    return isBerry(view.read("yarn.lock") ?? "") ? yarnBerryPlan() : yarnClassicPlan();
  return null;
}

function npmPlan(lockfile: string): NodePlan {
  // No project .npmrc reaches the download: it is not copied into the fetch directory, and
  // these flags, not a config file, set the registry, cache and script policy.
  const base = ["--no-audit", "--no-fund", `--cache=${NODE_CACHE}`];
  const env = {
    HOME: "/tmp",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  return {
    manager: "npm",
    lockfile,
    fetch: { argv: ["npm", "ci", "--ignore-scripts", `--registry=${REGISTRY}`, ...base], env },
    install: { argv: ["npm", "ci", "--offline", ...base], env },
    run: (s) => ({ argv: ["npm", "run", "--silent", s], env }),
  };
}

function pnpmPlan(binary: string): NodePlan {
  const store = `${NODE_CACHE}/pnpm`;
  // --ignore-pnpmfile stops a repo .pnpmfile.cjs hook; it is not in the fetch directory anyway.
  const base = [
    binary,
    "install",
    "--frozen-lockfile",
    "--ignore-pnpmfile",
    `--store-dir=${store}`,
  ];
  const env = { HOME: "/tmp", npm_config_update_notifier: "false" };
  return {
    manager: "pnpm",
    lockfile: "pnpm-lock.yaml",
    fetch: { argv: ["node", ...base, "--ignore-scripts", `--registry=${REGISTRY}`], env },
    install: { argv: ["node", ...base, "--offline"], env },
    run: (s) => ({ argv: ["node", binary, "--ignore-pnpmfile", "run", s], env }),
  };
}

function yarnClassicPlan(): NodePlan {
  const cache = `${NODE_CACHE}/yarn`;
  const base = [
    "node",
    YARN_CLASSIC,
    "install",
    "--frozen-lockfile",
    "--non-interactive",
    `--cache-folder=${cache}`,
  ];
  // YARN_IGNORE_PATH defeats a repo .yarnrc `yarn-path`; the file is not in the fetch dir anyway.
  const env = { HOME: "/tmp", YARN_IGNORE_PATH: "1", npm_config_registry: REGISTRY };
  return {
    manager: "yarn",
    lockfile: "yarn.lock",
    fetch: { argv: [...base, "--ignore-scripts"], env },
    install: { argv: [...base, "--offline"], env },
    run: (s) => ({
      argv: ["node", YARN_CLASSIC, "run", s],
      env: { ...env, YARN_IGNORE_SCRIPTS: "" },
    }),
  };
}

function yarnBerryPlan(): NodePlan {
  // Our config comes entirely from the environment; the repo's .yarnrc.yml and .yarn/ folder
  // are not in the fetch directory, and these variables (not a config file) pick the registry,
  // disable scripts, the global cache, plugins and a project yarn path.
  const env: Record<string, string> = {
    HOME: "/tmp",
    YARN_ENABLE_SCRIPTS: "0",
    YARN_ENABLE_GLOBAL_CACHE: "0",
    YARN_CACHE_FOLDER: `${NODE_CACHE}/yarn-berry`,
    YARN_ENABLE_IMMUTABLE_INSTALLS: "1",
    YARN_NODE_LINKER: "node-modules",
    YARN_PLUGINS: "",
    YARN_NPM_REGISTRY_SERVER: REGISTRY,
  };
  const base = ["node", YARN_BERRY, "install", "--mode=skip-build"];
  return {
    manager: "yarn-berry",
    lockfile: "yarn.lock",
    fetch: { argv: base, env },
    install: { argv: base, env: { ...env, YARN_ENABLE_NETWORK: "0" } },
    run: (s) => ({
      argv: ["node", YARN_BERRY, "run", s],
      env: { ...env, YARN_ENABLE_NETWORK: "0" },
    }),
  };
}
