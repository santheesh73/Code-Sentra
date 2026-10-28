import { parseLockfile } from "../audit/lockfiles.js";

export type ProbeName = "install" | "build" | "typecheck" | "lint" | "tests";
export const PROBES: readonly ProbeName[] = ["install", "build", "typecheck", "lint", "tests"];

export interface ProbeStep {
  name: ProbeName;
  /** Command run in the offline sandbox; null when the step does not run. */
  command: string[] | null;
  /** Why the step does not run. `not_applicable` steps are not gaps (nothing to measure). */
  skip: { kind: "not_applicable" | "gap"; reason: string } | null;
  timeoutMs: number;
}

export interface ProbePlan {
  ecosystem: "node" | "python" | "go" | "none";
  packageManager: "npm" | "pnpm" | "yarn" | "pip" | "go" | null;
  /** Dependency download (network on, project code never runs); null when nothing to fetch. */
  fetch: { command: string[]; reason: string } | null;
  /** Files rewritten in the scratch copy before fetch (sanitized requirements, disabled .npmrc). */
  prepare: { rename?: [string, string]; write?: [string, string] }[];
  steps: ProbeStep[];
  /** Why the fetch was refused, if it was (it becomes the install gap). */
  refused: string | null;
}

export interface ProjectView {
  files: Set<string>;
  read(path: string): string | null;
}

const NPM_REGISTRY = "https://registry.npmjs.org/";
const PYPI_INDEX = "https://pypi.org/simple";
const ALLOWED_TARBALL_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const MIN = 60_000;

const skip = (
  name: ProbeName,
  kind: "not_applicable" | "gap",
  reason: string,
  timeoutMs = MIN,
): ProbeStep => ({
  name,
  command: null,
  skip: { kind, reason },
  timeoutMs,
});
const step = (name: ProbeName, command: string[], timeoutMs: number): ProbeStep => ({
  name,
  command,
  skip: null,
  timeoutMs,
});
const sh = (script: string) => ["sh", "-c", script];

/**
 * Checks that every lockfile download URL points at the public registry. A lockfile can
 * name any URL (`"resolved": "http://169.254.169.254/..."`), and the package manager
 * would fetch it from the worker's network (ADR 0016), so anything else is refused.
 */
export function checkNpmLockUrls(lockText: string, lockPath: string): string | null {
  const p = parseLockfile(lockPath, lockText);
  if (!p) return `${lockPath} could not be parsed`;
  for (const pkg of p.packages) {
    if (!pkg.resolved) continue;
    let u: URL;
    try {
      u = new URL(pkg.resolved);
    } catch {
      return `${pkg.name} resolves to a non-URL source (${pkg.resolved.slice(0, 80)})`;
    }
    if (u.protocol !== "https:" || !ALLOWED_TARBALL_HOSTS.has(u.hostname))
      return `${pkg.name} would be downloaded from ${u.protocol}//${u.hostname}, not the public npm registry`;
  }
  return null;
}

/**
 * Rewrites a requirements file to plain requirement lines: pip options (`--index-url`,
 * `-e`, `-r`, `--trusted-host`, …) and direct URL references are dropped, because they
 * could point pip at internal hosts. Returns the sanitized text and what was dropped.
 */
export function sanitizeRequirements(text: string): { text: string; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("-") || /:\/\//.test(line) || /\s@\s/.test(line) || line.endsWith("\\")) {
      dropped.push(line);
      continue;
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*([<>=!~]=?[^;\s,]+(\s*,\s*[<>=!~]=?[^;\s,]+)*)?\s*(;.*)?$/.test(
        line,
      )
    ) {
      dropped.push(line);
      continue;
    }
    keep.push(line);
  }
  return { text: `${keep.join("\n")}\n`, dropped };
}

function nodePlan(view: ProjectView): ProbePlan {
  const pkg = JSON.parse(view.read("package.json") ?? "{}") as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
  };
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const plan: ProbePlan = {
    ecosystem: "node",
    packageManager: null,
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  if (view.files.has(".npmrc"))
    plan.prepare.push({ rename: [".npmrc", ".npmrc.codesentra-disabled"] });

  const env = "export COREPACK_HOME=/work/.cs-corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0;";
  let run: (script: string) => string[];
  if (view.files.has("package-lock.json") || view.files.has("npm-shrinkwrap.json")) {
    plan.packageManager = "npm";
    const lock = view.files.has("package-lock.json") ? "package-lock.json" : "npm-shrinkwrap.json";
    plan.refused = checkNpmLockUrls(view.read(lock) ?? "", lock);
    plan.fetch = {
      command: [
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--registry=${NPM_REGISTRY}`,
      ],
      reason: `npm ci from ${lock} with install scripts disabled`,
    };
    run = (s) => ["npm", "run", "--silent", s];
  } else if (view.files.has("pnpm-lock.yaml")) {
    plan.packageManager = "pnpm";
    plan.fetch = {
      command: sh(
        `${env} corepack pnpm install --frozen-lockfile --ignore-scripts --registry=${NPM_REGISTRY}`,
      ),
      reason: "pnpm install --frozen-lockfile with install scripts disabled",
    };
    run = (s) => sh(`${env} corepack pnpm run ${s}`);
  } else if (view.files.has("yarn.lock")) {
    plan.packageManager = "yarn";
    plan.fetch = {
      command: sh(
        `${env} corepack yarn install --frozen-lockfile --ignore-scripts --registry ${NPM_REGISTRY}`,
      ),
      reason: "yarn install --frozen-lockfile with install scripts disabled",
    };
    run = (s) => sh(`${env} corepack yarn run ${s}`);
  } else {
    plan.packageManager = "npm";
    const noDeps = Object.keys(deps).length === 0;
    plan.steps.push(
      noDeps
        ? skip("install", "not_applicable", "package.json declares no dependencies")
        : skip(
            "install",
            "gap",
            "no lockfile, so dependencies were not installed (installs must be reproducible)",
          ),
    );
    run = (s) => ["npm", "run", "--silent", s];
    if (!noDeps) {
      for (const name of ["build", "typecheck", "lint", "tests"] as const)
        plan.steps.push(skip(name, "gap", "dependencies were not installed"));
      return plan;
    }
  }
  if (plan.fetch) {
    // Install scripts run here, offline, inside the sandbox.
    plan.steps.push(
      step(
        "install",
        plan.packageManager === "npm" ? ["npm", "rebuild"] : run("--if-present postinstall"),
        10 * MIN,
      ),
    );
  }
  plan.steps.push(
    scripts.build
      ? step("build", run("build"), 10 * MIN)
      : skip("build", "not_applicable", "package.json has no build script"),
  );
  const hasTs = view.files.has("tsconfig.json") && "typescript" in deps;
  plan.steps.push(
    scripts.typecheck
      ? step("typecheck", run("typecheck"), 5 * MIN)
      : hasTs
        ? step(
            "typecheck",
            ["npx", "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"],
            5 * MIN,
          )
        : skip(
            "typecheck",
            view.files.has("tsconfig.json") ? "gap" : "not_applicable",
            view.files.has("tsconfig.json")
              ? "tsconfig.json exists but typescript is not a dependency"
              : "not a TypeScript project",
          ),
  );
  plan.steps.push(
    scripts.lint
      ? step("lint", run("lint"), 5 * MIN)
      : skip("lint", "gap", "no lint script in package.json"),
  );
  const test = scripts.test;
  plan.steps.push(
    test && !/no test specified/.test(test)
      ? step("tests", run("test"), 10 * MIN)
      : skip("tests", "gap", "no test script in package.json"),
  );
  return plan;
}

const PY_DEV_FILES = [
  "requirements-dev.txt",
  "dev-requirements.txt",
  "requirements/dev.txt",
  "test-requirements.txt",
  "requirements-test.txt",
  "requirements/test.txt",
];

function pythonPlan(view: ProjectView): ProbePlan {
  const plan: ProbePlan = {
    ecosystem: "python",
    packageManager: "pip",
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  const reqFiles = ["requirements.txt", ...PY_DEV_FILES].filter((f) => view.files.has(f));
  if (!reqFiles.length) {
    plan.steps.push(
      skip("install", "gap", "no pinned requirements file, so dependencies were not installed"),
    );
    for (const n of ["build", "typecheck", "lint", "tests"] as const)
      plan.steps.push(skip(n, "gap", "dependencies were not installed"));
    return plan;
  }
  const dropped: string[] = [];
  const reqText: string[] = [];
  for (const f of reqFiles) {
    const s = sanitizeRequirements(view.read(f) ?? "");
    dropped.push(...s.dropped.map((d) => `${f}: ${d}`));
    plan.prepare.push({ write: [`.cs-req/${f.replace(/\//g, "__")}`, s.text] });
    reqText.push(s.text);
  }
  const rArgs = reqFiles.map((f) => `-r .cs-req/${f.replace(/\//g, "__")}`).join(" ");
  plan.fetch = {
    command: sh(
      `python -m pip download --only-binary=:all: --no-cache-dir --dest .cs-wheels --index-url ${PYPI_INDEX} ${rArgs}`,
    ),
    reason: `pip download (wheels only, no setup.py runs) for ${reqFiles.join(", ")}${dropped.length ? `; dropped: ${dropped.join("; ")}` : ""}`,
  };
  const all = reqText.join("\n").toLowerCase();
  const has = (n: string) => new RegExp(`^${n}\\b`, "m").test(all);
  const py = ".cs-venv/bin/python";
  plan.steps.push(
    step(
      "install",
      sh(
        `python -m venv .cs-venv && ${py} -m pip install --no-index --find-links .cs-wheels ${rArgs}`,
      ),
      10 * MIN,
    ),
  );
  const pyproject = view.read("pyproject.toml") ?? "";
  plan.steps.push(
    /^\[build-system\]/m.test(pyproject) || view.files.has("setup.py")
      ? step(
          "build",
          [
            py,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--no-build-isolation",
            "--no-index",
            "-w",
            "/tmp/wheel",
            ".",
          ],
          10 * MIN,
        )
      : skip(
          "build",
          "not_applicable",
          "Python project without a build step (no [build-system] or setup.py)",
        ),
  );
  plan.steps.push(
    has("mypy")
      ? step("typecheck", [py, "-m", "mypy", "."], 5 * MIN)
      : skip("typecheck", "gap", "no type checker (mypy) in the requirements"),
  );
  plan.steps.push(
    has("ruff")
      ? step("lint", [py, "-m", "ruff", "check", "."], 5 * MIN)
      : has("flake8")
        ? step("lint", [py, "-m", "flake8"], 5 * MIN)
        : skip("lint", "gap", "no linter (ruff, flake8) in the requirements"),
  );
  plan.steps.push(
    has("pytest")
      ? step(
          "tests",
          [py, "-m", "pytest", "-q", "-rfEs", "--no-header", "-p", "no:cacheprovider"],
          10 * MIN,
        )
      : skip("tests", "gap", "pytest is not in the requirements"),
  );
  return plan;
}

/** The Go toolchain in the sandbox image (infra/sandbox/Dockerfile; a test keeps them equal). */
export const SANDBOX_GO_VERSION = "1.27.2";
const GO_PROXY = "https://proxy.golang.org";
const GO_SUMDB = "sum.golang.org";

const goVersionParts = (v: string) => v.split(".").map((x) => Number.parseInt(x, 10) || 0);
function goAtLeast(have: string, need: string): boolean {
  const a = goVersionParts(have);
  const b = goVersionParts(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/**
 * Go (ADR 0026). `go mod download` fetches modules without running any code, from the
 * public module proxy only (no `direct` fallback, so no VCS hosts) and checked against the
 * public checksum database. Everything after runs offline from that cache, cgo off (the
 * sandbox has no C toolchain).
 */
function goPlan(view: ProjectView): ProbePlan {
  const plan: ProbePlan = {
    ecosystem: "go",
    packageManager: "go",
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  const gomod = view.read("go.mod") ?? "";
  const need = /^go\s+(\d+(?:\.\d+){0,2})/m.exec(gomod)?.[1];
  const all = ["install", "build", "typecheck", "lint", "tests"] as const;
  if (need && !goAtLeast(SANDBOX_GO_VERSION, need)) {
    for (const n of all)
      plan.steps.push(
        skip(n, "gap", `go.mod needs Go ${need}; the sandbox has Go ${SANDBOX_GO_VERSION}`),
      );
    return plan;
  }
  const common =
    "GOTOOLCHAIN=local GOWORK=off GOENV=off GOMODCACHE=/work/.cs-gomod GOCACHE=/tmp/gocache CGO_ENABLED=0";
  const offline = `${common} GOFLAGS=-mod=readonly GOPROXY=off`;
  const requires = /^require\s/m.test(gomod);
  if (requires) {
    if (!view.files.has("go.sum")) {
      plan.steps.push(
        skip("install", "gap", "go.mod requires modules but there is no go.sum to verify them"),
      );
      for (const n of ["build", "typecheck", "lint", "tests"] as const)
        plan.steps.push(skip(n, "gap", "dependencies were not downloaded"));
      return plan;
    }
    plan.fetch = {
      command: sh(
        `${common} GOFLAGS=-mod=readonly GOPROXY=${GO_PROXY} GOSUMDB=${GO_SUMDB} GONOSUMDB= GONOPROXY= GOPRIVATE= GOINSECURE= go mod download`,
      ),
      reason: `go mod download from ${GO_PROXY} only, verified against ${GO_SUMDB} (no code runs)`,
    };
    plan.steps.push(step("install", sh(`${offline} go mod verify`), 5 * MIN));
  } else {
    plan.steps.push(skip("install", "not_applicable", "go.mod requires no modules"));
  }
  plan.steps.push(step("build", sh(`${offline} go build ./...`), 10 * MIN));
  plan.steps.push(skip("typecheck", "not_applicable", "go build type-checks every package"));
  plan.steps.push(step("lint", sh(`${offline} go vet ./...`), 5 * MIN));
  plan.steps.push(step("tests", sh(`${offline} go test -json ./...`), 10 * MIN));
  return plan;
}

/** Projects whose dependency download would run code: every step is a gap with that reason. */
function refusedEcosystem(reason: string): ProbePlan {
  return {
    ecosystem: "none",
    packageManager: null,
    fetch: null,
    prepare: [],
    steps: (["install", "build", "typecheck", "lint", "tests"] as const).map((n) =>
      skip(n, "gap", reason),
    ),
    refused: null,
  };
}

/** Decides what to run for a project, from its manifests only. Pure. */
export function planProbes(view: ProjectView): ProbePlan {
  if (view.files.has("package.json")) return nodePlan(view);
  if (
    view.files.has("requirements.txt") ||
    view.files.has("pyproject.toml") ||
    view.files.has("setup.py")
  )
    return pythonPlan(view);
  if (view.files.has("go.mod")) return goPlan(view);
  if (view.files.has("Gemfile"))
    return refusedEcosystem(
      "not run: Bundler evaluates the Gemfile (Ruby code) to download gems, so the dependency download would run project code",
    );
  if (
    view.files.has("pom.xml") ||
    view.files.has("build.gradle") ||
    view.files.has("build.gradle.kts")
  )
    return refusedEcosystem(
      "not run: Maven and Gradle run build plugins or build scripts to resolve dependencies, so the dependency download would run code",
    );
  return refusedEcosystem(
    "no supported manifest (package.json, requirements.txt, pyproject.toml, go.mod) at the project root",
  );
}
