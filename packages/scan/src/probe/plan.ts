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
  /**
   * Failures that are the sandbox's limit, not the project's (no make or C headers, a pinned
   * runtime the sandbox lacks, an artifact the offline cache missed): when the output
   * matches, the step is reported as not run, with the reason, instead of failed.
   */
  gapWhen?: { pattern: RegExp; reason: string }[];
}

export interface ProbePlan {
  ecosystem: "node" | "python" | "go" | "ruby" | "maven" | "rust" | "php" | "none";
  packageManager:
    | "npm"
    | "pnpm"
    | "yarn"
    | "pip"
    | "go"
    | "bundler"
    | "maven"
    | "cargo"
    | "composer"
    | null;
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

/** The Ruby in the sandbox image (ADR 0027; a test keeps it equal to the Dockerfile). */
export const SANDBOX_RUBY_VERSION = "3.4.10";
const RUBYGEMS = "https://rubygems.org/";
const GEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GEM_VERSION = /^[0-9][0-9A-Za-z._-]*$/;

export interface LockedGem {
  name: string;
  /** As locked, platform included (`1.16.0-x86_64-linux`): the .gem file's name. */
  version: string;
  sha256: string | null;
}

/**
 * The gems a Gemfile.lock pins, for a download that runs no code: every `GEM` section
 * must name rubygems.org; `GIT` sources would need network access to a repository and are
 * refused; `PATH` gems are in the tree already. CHECKSUMS (Bundler 2.5+) give each file's
 * sha256. Returns the refusal reason instead when the lockfile cannot be honoured safely.
 */
export function lockedGems(text: string): { gems: LockedGem[] } | { refused: string } {
  const gems: LockedGem[] = [];
  const sums = new Map<string, string>();
  let section = "";
  let remote = "";
  let inSpecs = false;
  for (const raw of text.split("\n")) {
    if (/^\S/.test(raw)) {
      section = raw.trim();
      remote = "";
      inSpecs = false;
      continue;
    }
    const r = /^ {2}remote: (\S+)/.exec(raw);
    if (r) remote = r[1] as string;
    if (/^ {2}specs:\s*$/.test(raw)) {
      inSpecs = true;
      continue;
    }
    if (section === "CHECKSUMS") {
      const c = /^ {2}(\S+) \(([^)]+)\)(?: sha256=([0-9a-f]{64}))?/.exec(raw);
      if (c?.[3]) sums.set(`${c[1]} ${c[2]}`, c[3]);
      continue;
    }
    if (!inSpecs) continue;
    const m = /^ {4}(\S+) \(([^)]+)\)\s*$/.exec(raw);
    if (!m) continue;
    const [, name, version] = m as unknown as [string, string, string];
    if (section === "GIT") return { refused: `${name} comes from a git repository (${remote})` };
    if (section !== "GEM") continue; // PATH gems are already in the tree
    if (remote.replace(/\/?$/, "/") !== RUBYGEMS)
      return { refused: `${name} comes from ${remote}, not rubygems.org` };
    if (!GEM_NAME.test(name) || !GEM_VERSION.test(version))
      return {
        refused: `the lockfile entry ${name} (${version}) is not a plain gem name and version`,
      };
    gems.push({ name, version, sha256: null });
  }
  for (const g of gems) g.sha256 = sums.get(`${g.name} ${g.version}`) ?? null;
  return { gems };
}

/**
 * The download script (ours, never the project's): fetches each locked .gem over HTTPS
 * from rubygems.org, following redirects only to https rubygems.org hosts, and checks the
 * lockfile's sha256 where there is one. Run with `python -I`, so nothing in the tree loads.
 */
const GEM_FETCH_PY = `import hashlib, sys, urllib.parse, urllib.request
class OnlyRubygems(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlsplit(newurl)
        if u.scheme != "https" or not (u.hostname == "rubygems.org" or u.hostname.endswith(".rubygems.org")):
            raise urllib.error.HTTPError(newurl, code, "redirect outside rubygems.org refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)
opener = urllib.request.build_opener(OnlyRubygems)
for line in open(".cs-gems/list.txt"):
    name, version, sha = line.split()
    with opener.open(f"https://rubygems.org/downloads/{name}-{version}.gem", timeout=60) as r:
        data = r.read(200 * 1024 * 1024)
    if sha != "-" and hashlib.sha256(data).hexdigest() != sha:
        sys.exit(f"{name}-{version}.gem does not match its Gemfile.lock checksum")
    with open(f".cs-gems/{name}-{version}.gem", "wb") as f:
        f.write(data)
print("downloaded", sum(1 for _ in open(".cs-gems/list.txt")), "gems")
`;

/** Ruby with Bundler (ADR 0027): the download is plain HTTPS from the lockfile; no Gemfile runs. */
function rubyPlan(view: ProjectView): ProbePlan {
  const plan: ProbePlan = {
    ecosystem: "ruby",
    packageManager: "bundler",
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  const all = ["install", "build", "typecheck", "lint", "tests"] as const;
  const lockText = view.read("Gemfile.lock");
  if (lockText === null) {
    plan.steps.push(
      skip(
        "install",
        "gap",
        "no Gemfile.lock, so gems were not installed (installs must be reproducible)",
      ),
    );
    for (const n of all.slice(1)) plan.steps.push(skip(n, "gap", "gems were not installed"));
    return plan;
  }
  const locked = lockedGems(lockText);
  if ("refused" in locked) {
    plan.refused = `not downloaded: ${locked.refused}`;
  } else if (locked.gems.length) {
    const verified = locked.gems.filter((g) => g.sha256).length;
    plan.prepare.push(
      { write: [".cs-gems/fetch.py", GEM_FETCH_PY] },
      {
        write: [
          ".cs-gems/list.txt",
          `${locked.gems.map((g) => `${g.name} ${g.version} ${g.sha256 ?? "-"}`).join("\n")}\n`,
        ],
      },
    );
    plan.fetch = {
      command: ["python", "-I", ".cs-gems/fetch.py"],
      reason: `the ${locked.gems.length} .gem files Gemfile.lock pins, from rubygems.org (${
        verified === locked.gems.length
          ? "every one checked against the lockfile's sha256"
          : `${verified} checked against the lockfile's sha256; the lockfile has no checksum for the rest`
      }; no code runs)`,
    };
  }
  // The project's Bundler settings could point installs elsewhere; ours come from the env.
  if (view.files.has(".bundle/config"))
    plan.prepare.push({ rename: [".bundle/config", ".bundle/config.codesentra-disabled"] });
  const env =
    "BUNDLE_PATH=/work/.cs-bundle BUNDLE_CACHE_PATH=.cs-gems BUNDLE_FROZEN=true BUNDLE_VERSION=system";
  const lock = lockText.toLowerCase();
  const has = (gem: string) => new RegExp(`^ {4}${gem} \\(`, "m").test(lock);
  const sandboxLimits = [
    {
      pattern:
        /Failed to build gem native extension|make: not found|You have to install development tools/,
      reason:
        "a gem has a native extension, and the sandbox cannot build it (no make, no Ruby headers)",
    },
    {
      pattern: /Your Ruby version is [\d.]+, but your Gemfile specified/,
      reason: `the Gemfile pins a Ruby other than the sandbox's ${SANDBOX_RUBY_VERSION}`,
    },
  ];
  plan.steps.push({
    ...step("install", sh(`${env} bundle install --local`), 10 * MIN),
    gapWhen: sandboxLimits,
  });
  plan.steps.push(skip("build", "not_applicable", "Ruby has no compile step"));
  plan.steps.push(
    has("steep")
      ? step("typecheck", sh(`${env} bundle exec steep check`), 5 * MIN)
      : has("sorbet")
        ? step("typecheck", sh(`${env} bundle exec srb tc`), 5 * MIN)
        : skip("typecheck", "gap", "no type checker (Sorbet, Steep) in Gemfile.lock"),
  );
  plan.steps.push(
    has("rubocop")
      ? step("lint", sh(`${env} bundle exec rubocop`), 5 * MIN)
      : skip("lint", "gap", "no linter (RuboCop) in Gemfile.lock"),
  );
  plan.steps.push(
    has("rspec-core")
      ? { ...step("tests", sh(`${env} bundle exec rspec`), 10 * MIN), gapWhen: sandboxLimits }
      : has("minitest") && view.files.has("Rakefile")
        ? { ...step("tests", sh(`${env} bundle exec rake test`), 10 * MIN), gapWhen: sandboxLimits }
        : skip(
            "tests",
            "gap",
            "no test runner (RSpec, or Minitest with a Rakefile) in Gemfile.lock",
          ),
  );
  return plan;
}

/** The JDK and Maven in the sandbox image (ADR 0027; a test keeps them equal). */
export const SANDBOX_JAVA_VERSION = "21";
export const SANDBOX_MAVEN_VERSION = "3.9.12";
/** Maven's own dependency plugin, pinned: the only plugin the download step runs. */
const DEPENDENCY_PLUGIN = "org.apache.maven.plugins:maven-dependency-plugin:3.11.0";
const MAVEN_CENTRAL = "https://repo.maven.apache.org/maven2";

/**
 * The Maven download script (ours). Every repository resolves through one mirror, Maven
 * Central; `-C` fails on a checksum mismatch. It runs only the pinned dependency plugin:
 * `go-offline` downloads the project's dependencies and plugins without executing them,
 * then the test providers Surefire/Failsafe and the JUnit launcher, which Maven resolves
 * only when tests run. The proxy and CA blocks apply only where the worker's egress needs
 * them.
 */
const MAVEN_FETCH_SH = `set -eu
M2=/work/.cs-m2
proxy=""
if [ -n "\${HTTPS_PROXY:-}" ]; then
  hp=\${HTTPS_PROXY#*://}; hp=\${hp%%/*}; host=\${hp%:*}; port=\${hp##*:}
  proxy="<proxies><proxy><id>egress</id><active>true</active><protocol>https</protocol><host>$host</host><port>$port</port></proxy></proxies>"
fi
cat > $M2/settings.xml <<XML
<settings><localRepository>$M2/repository</localRepository>$proxy<mirrors><mirror><id>central-only</id><mirrorOf>*</mirrorOf><url>${MAVEN_CENTRAL}</url></mirror></mirrors></settings>
XML
if [ -f /etc/codesentra-ca.pem ]; then
  cp "$JAVA_HOME/lib/security/cacerts" $M2/cacerts && chmod u+w $M2/cacerts
  keytool -importcert -noprompt -alias egress -file /etc/codesentra-ca.pem -keystore $M2/cacerts -storepass changeit >/dev/null
  export MAVEN_OPTS="-Djavax.net.ssl.trustStore=$M2/cacerts -Djavax.net.ssl.trustStorePassword=changeit"
fi
mvn() { command mvn -B -q -s $M2/settings.xml -C "$@"; }
mvn ${DEPENDENCY_PLUGIN}:go-offline
for plugin in maven-surefire-plugin maven-failsafe-plugin; do
  for dir in $M2/repository/org/apache/maven/plugins/$plugin/*/; do
    [ -d "$dir" ] || continue
    for provider in surefire-junit-platform surefire-junit4 surefire-junit47 surefire-testng; do
      mvn ${DEPENDENCY_PLUGIN}:get -Dtransitive=true -Dartifact=org.apache.maven.surefire:$provider:$(basename "$dir") || true
    done
  done
done
for dir in $M2/repository/org/junit/platform/junit-platform-commons/*/; do
  [ -d "$dir" ] || continue
  mvn ${DEPENDENCY_PLUGIN}:get -Dtransitive=true -Dartifact=org.junit.platform:junit-platform-launcher:$(basename "$dir") || true
done
`;

/**
 * Maven (ADR 0027). The download runs no project code: `.mvn/` (JVM options, Maven
 * arguments, extensions) is set aside and POMs declaring build extensions are refused, since
 * Maven loads those at startup. Everything after runs offline from the downloaded repository.
 */
function mavenPlan(view: ProjectView): ProbePlan {
  const plan: ProbePlan = {
    ecosystem: "maven",
    packageManager: "maven",
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  const poms = [...view.files].filter((f) => /(^|\/)pom\.xml$/.test(f));
  const withExtensions = poms.find((f) =>
    /<extensions>\s*true\s*<\/extensions>|<extensions>\s*<extension>/.test(
      (view.read(f) ?? "").replace(/<!--[\s\S]*?-->/g, ""),
    ),
  );
  if (view.files.has(".mvn/extensions.xml"))
    plan.refused =
      "not downloaded: .mvn/extensions.xml declares Maven core extensions, which run when Maven starts";
  else if (withExtensions)
    plan.refused = `not downloaded: ${withExtensions} declares build extensions, which Maven loads and runs when it starts`;
  // .mvn/jvm.config and .mvn/maven.config would add JVM and Maven options to every run.
  for (const f of [...view.files].filter((x) => x.startsWith(".mvn/")))
    plan.prepare.push({ rename: [f, `${f}.codesentra-disabled`] });
  plan.prepare.push({ write: [".cs-m2/fetch.sh", MAVEN_FETCH_SH] });
  plan.fetch = {
    command: ["sh", ".cs-m2/fetch.sh"],
    reason: `the project's dependencies and plugins from Maven Central only (every repository mirrored to it, checksums enforced), with Maven's pinned dependency plugin; no project code runs`,
  };
  const mvn = (args: string) => sh(`mvn -B -o -s .cs-m2/settings.xml ${args}`);
  const sandboxLimits = [
    {
      pattern: /has not been downloaded from it before|Cannot access \S+ \(\S+\) in offline mode/,
      reason:
        "Maven needed an artifact at build time that the offline download did not fetch (resolved dynamically by a plugin)",
    },
    {
      pattern:
        /release version \d+ not supported|invalid target release|UnsupportedClassVersionError/,
      reason: `the project targets a newer Java than the sandbox's ${SANDBOX_JAVA_VERSION}`,
    },
  ];
  plan.steps.push({
    ...step("install", mvn(`-q ${DEPENDENCY_PLUGIN}:resolve`), 5 * MIN),
    gapWhen: sandboxLimits,
  });
  plan.steps.push({
    ...step("build", mvn("-DskipTests package"), 10 * MIN),
    gapWhen: sandboxLimits,
  });
  plan.steps.push(skip("typecheck", "not_applicable", "javac type-checks during the build"));
  plan.steps.push(
    skip("lint", "gap", "no linter (Checkstyle, SpotBugs) is run for Maven projects"),
  );
  plan.steps.push({ ...step("tests", mvn("test"), 10 * MIN), gapWhen: sandboxLimits });
  return plan;
}

/** The Rust toolchain in the sandbox image (ADR 0028; a test keeps it equal to the Dockerfile). */
export const SANDBOX_RUST_VERSION = "1.99.0";

/**
 * The Cargo download (ours). `cargo fetch --locked` downloads the crates Cargo.lock pins and
 * checks each against the lockfile's checksum; it runs no build script and no proc macro. The
 * toolchain is on PATH directly (no rustup), so a rust-toolchain file cannot swap it, and
 * `CARGO_HOME` is ours, so no config but ours applies (the project's `.cargo/` is set aside).
 */
const CARGO_ENV =
  "CARGO_HOME=/work/.cs-cargo RUSTC=/opt/rust/bin/rustc RUSTC_WRAPPER= RUSTC_WORKSPACE_WRAPPER= CARGO_TERM_COLOR=never";
const CARGO_FETCH_SH = `set -eu
if [ -f /etc/codesentra-ca.pem ]; then export CARGO_HTTP_CAINFO=/etc/codesentra-ca.pem; fi
export ${CARGO_ENV} CARGO_NET_GIT_FETCH_WITH_CLI=false
cargo fetch --locked
`;

/**
 * Rust with Cargo (ADR 0028): crates.io only, pinned by Cargo.lock; build scripts, proc macros
 * and tests run offline.
 */
function rustPlan(view: ProjectView): ProbePlan {
  const plan: ProbePlan = {
    ecosystem: "rust",
    packageManager: "cargo",
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  const all = ["install", "build", "typecheck", "lint", "tests"] as const;
  const lockText = view.read("Cargo.lock");
  if (lockText === null) {
    plan.steps.push(
      skip(
        "install",
        "gap",
        "no Cargo.lock, so crates were not downloaded (installs must be reproducible)",
      ),
    );
    for (const n of all.slice(1)) plan.steps.push(skip(n, "gap", "crates were not downloaded"));
    return plan;
  }
  const lock = parseLockfile("Cargo.lock", lockText);
  if (!lock) plan.refused = "not downloaded: Cargo.lock could not be read";
  else if (lock.unpinned[0])
    plan.refused = `not downloaded: ${lock.unpinned[0].text.replace(/ \((\w+) source\)$/, " comes from a $1 source, not crates.io")}`;
  for (const f of [...view.files].filter((x) => x.startsWith(".cargo/")))
    plan.prepare.push({ rename: [f, `${f}.codesentra-disabled`] });
  if (lock?.packages.length) {
    plan.prepare.push({ write: [".cs-cargo/fetch.sh", CARGO_FETCH_SH] });
    plan.fetch = {
      command: ["sh", ".cs-cargo/fetch.sh"],
      reason: `the ${lock.packages.length} crates Cargo.lock pins, from crates.io only, each checked against the lockfile's checksum (cargo fetch; no build script runs)`,
    };
  }
  const cargo = (args: string) => sh(`${CARGO_ENV} CARGO_NET_OFFLINE=true cargo ${args}`);
  const sandboxLimits = [
    {
      pattern:
        /requires rustc \d+\.\d+(?:\.\d+)? or newer|is not supported by the following package|feature `[\w-]+` is required/,
      reason: `a crate needs a newer Rust than the sandbox's ${SANDBOX_RUST_VERSION}`,
    },
    {
      pattern:
        /pkg-config|Could not find directory of OpenSSL|failed to run custom build command for `\S*-sys /,
      reason: "a crate links a system library (found with pkg-config) the sandbox does not have",
    },
  ];
  plan.steps.push({
    ...step("install", cargo("metadata --frozen --format-version 1 --quiet >/dev/null"), 5 * MIN),
    gapWhen: sandboxLimits,
  });
  plan.steps.push({ ...step("build", cargo("build --frozen"), 15 * MIN), gapWhen: sandboxLimits });
  plan.steps.push(skip("typecheck", "not_applicable", "cargo build type-checks every crate"));
  plan.steps.push({
    ...step("lint", cargo("clippy --frozen --all-targets -- -D warnings"), 10 * MIN),
    gapWhen: sandboxLimits,
  });
  plan.steps.push({
    ...step("tests", cargo("test --frozen --no-fail-fast"), 15 * MIN),
    gapWhen: sandboxLimits,
  });
  return plan;
}

/** The PHP and Composer in the sandbox image (ADR 0028; a test keeps them equal). */
export const SANDBOX_PHP_VERSION = "8.4.27";
export const SANDBOX_COMPOSER_VERSION = "2.10.3";
const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;

export interface LockedComposerPackage {
  name: string;
  /** Always codeload.github.com: the zip of the locked commit. */
  url: string;
  sha1: string | null;
  /** The lock entry, as `vendor/composer/installed.json` lists it. */
  entry: Record<string, unknown>;
  dev: boolean;
}

/**
 * The packages a composer.lock pins, for a download that runs no code. Each must be a zip
 * of a commit on GitHub (Packagist's default for public packages): the URL is rewritten to
 * codeload.github.com, which serves it without the API's rate limit. Anything else (other
 * hosts, path or VCS-only packages) is refused with the reason.
 */
export function lockedComposer(
  text: string,
): { packages: LockedComposerPackage[] } | { refused: string } {
  let doc: Record<string, Record<string, unknown>[] | undefined>;
  try {
    doc = JSON.parse(text);
  } catch {
    return { refused: "composer.lock is not valid JSON" };
  }
  const out: LockedComposerPackage[] = [];
  for (const key of ["packages", "packages-dev"]) {
    for (const pkg of doc[key] ?? []) {
      const name = String(pkg.name ?? "");
      if (!COMPOSER_NAME.test(name))
        return { refused: `the lockfile entry "${name.slice(0, 80)}" is not a plain package name` };
      if (pkg.type === "metapackage") continue;
      const dist = pkg.dist as
        | { type?: string; url?: string; reference?: string; shasum?: string }
        | undefined;
      if (!dist?.url || dist.type !== "zip")
        return {
          refused: `${name} has no zip download in composer.lock (${dist?.type ?? "source only"})`,
        };
      let u: URL;
      try {
        u = new URL(dist.url);
      } catch {
        return { refused: `${name} has a download that is not a URL` };
      }
      const api = /^\/repos\/([\w.-]+)\/([\w.-]+)\/zipball\/([0-9a-f]{40})$/.exec(u.pathname);
      const direct = /^\/([\w.-]+)\/([\w.-]+)\/(?:legacy\.)?zip\/([0-9a-f]{40})$/.exec(u.pathname);
      const m =
        u.protocol === "https:" && u.hostname === "api.github.com"
          ? api
          : u.protocol === "https:" && u.hostname === "codeload.github.com"
            ? direct
            : null;
      if (!m)
        return {
          refused: `${name} would be downloaded from ${u.protocol}//${u.hostname}, not a GitHub commit zip`,
        };
      out.push({
        name,
        url: `https://codeload.github.com/${m[1]}/${m[2]}/legacy.zip/${m[3]}`,
        sha1: /^[0-9a-f]{40}$/.test(dist.shasum ?? "") ? (dist.shasum as string) : null,
        entry: { ...pkg, "install-path": `../${name}` },
        dev: key === "packages-dev",
      });
    }
  }
  return { packages: out };
}

/**
 * The Composer download script (ours, never the project's): each locked zip from
 * codeload.github.com, with redirects refused, checked against the lockfile's sha1 where there
 * is one, unpacked into vendor/ (paths that would leave it are refused). Composer itself does
 * not run during the download. Run with `python -I`, so nothing in the tree loads.
 */
const COMPOSER_FETCH_PY = `import hashlib, io, os, shutil, sys, urllib.request, zipfile
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, "redirect refused", headers, fp)
opener = urllib.request.build_opener(NoRedirect)
shutil.rmtree("vendor", ignore_errors=True)
count = 0
for line in open(".cs-composer/list.txt"):
    name, url, sha = line.split()
    with opener.open(url, timeout=120) as r:
        data = r.read(200 * 1024 * 1024)
    if sha != "-" and hashlib.sha1(data).hexdigest() != sha:
        sys.exit(f"{name} does not match its composer.lock checksum")
    dest = os.path.realpath(os.path.join("vendor", name))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            rel = info.filename.split("/", 1)[1] if "/" in info.filename else ""
            if not rel or (info.external_attr >> 16) & 0o170000 == 0o120000:
                continue
            target = os.path.realpath(os.path.join(dest, rel))
            if not target.startswith(dest + os.sep):
                sys.exit(f"{name}: {info.filename} would unpack outside vendor/{name}")
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    count += 1
os.makedirs("vendor/composer", exist_ok=True)
shutil.copy(".cs-composer/installed.json", "vendor/composer/installed.json")
print("downloaded", count, "packages")
`;

/**
 * PHP with Composer (ADR 0028): our script downloads the locked zips; then, offline, Composer
 * writes the autoloader (no scripts, no plugins) and the project's tools run from vendor/.
 */
function phpPlan(view: ProjectView): ProbePlan {
  const plan: ProbePlan = {
    ecosystem: "php",
    packageManager: "composer",
    fetch: null,
    prepare: [],
    steps: [],
    refused: null,
  };
  const all = ["install", "build", "typecheck", "lint", "tests"] as const;
  const lockText = view.read("composer.lock");
  let locked: LockedComposerPackage[] = [];
  if (lockText === null) {
    const json = JSON.parse(view.read("composer.json") ?? "{}") as {
      require?: Record<string, string>;
      "require-dev"?: Record<string, string>;
    };
    if (Object.keys({ ...json.require, ...json["require-dev"] }).some((n) => n.includes("/"))) {
      plan.steps.push(
        skip(
          "install",
          "gap",
          "no composer.lock, so packages were not installed (installs must be reproducible)",
        ),
      );
      for (const n of all.slice(1)) plan.steps.push(skip(n, "gap", "packages were not installed"));
      return plan;
    }
  } else {
    const r = lockedComposer(lockText);
    if ("refused" in r) plan.refused = `not downloaded: ${r.refused}`;
    else locked = r.packages;
  }
  if (locked.length) {
    const verified = locked.filter((p) => p.sha1).length;
    const installed = {
      packages: locked.map((p) => p.entry),
      dev: true,
      "dev-package-names": locked.filter((p) => p.dev).map((p) => p.name),
    };
    plan.prepare.push(
      { write: [".cs-composer/fetch.py", COMPOSER_FETCH_PY] },
      {
        write: [
          ".cs-composer/list.txt",
          `${locked.map((p) => `${p.name} ${p.url} ${p.sha1 ?? "-"}`).join("\n")}\n`,
        ],
      },
      { write: [".cs-composer/installed.json", `${JSON.stringify(installed, null, 2)}\n`] },
    );
    plan.fetch = {
      command: ["python", "-I", ".cs-composer/fetch.py"],
      reason: `the ${locked.length} package zips composer.lock pins, each the zip of a locked commit from codeload.github.com (${
        verified === locked.length
          ? "every one checked against the lockfile's sha1"
          : verified
            ? `${verified} checked against the lockfile's sha1; the lockfile has no checksum for the rest`
            : "the lockfile has no checksums; the commit is pinned and the download is over HTTPS"
      }; Composer does not run)`,
    };
  }
  // A project-level Composer config or auth file applies to every Composer run; ours come from the env.
  for (const f of ["auth.json", ".composer/config.json"])
    if (view.files.has(f)) plan.prepare.push({ rename: [f, `${f}.codesentra-disabled`] });
  const env =
    "COMPOSER_HOME=/tmp/composer COMPOSER_NO_INTERACTION=1 COMPOSER_DISABLE_NETWORK=1 COMPOSER_ALLOW_SUPERUSER=0";
  const binOf = (pkg: string): string | null => {
    const p = locked.find((x) => x.name === pkg);
    const bin = (p?.entry.bin as string[] | undefined)?.[0];
    return p && bin ? `vendor/${pkg}/${bin}` : null;
  };
  const sandboxLimits = [
    {
      pattern:
        /Composer detected issues in your platform|Your Composer dependencies require a PHP version|require the following PHP extensions to be installed|requires PHP version/,
      reason: `the project needs a PHP version or extension the sandbox's PHP ${SANDBOX_PHP_VERSION} does not have`,
    },
  ];
  plan.steps.push({
    ...step("install", sh(`${env} composer dump-autoload --no-scripts --no-plugins`), 5 * MIN),
    gapWhen: sandboxLimits,
  });
  plan.steps.push(
    step(
      "build",
      sh(
        `find . -name '*.php' -not -path './vendor/*' -not -path './.cs-*' -exec sh -c 'rc=0; for f; do php -l "$f" >/tmp/lint.out 2>&1 || { cat /tmp/lint.out; rc=1; }; done; exit $rc' sh {} +`,
      ),
      5 * MIN,
    ),
  );
  const config = (names: string[]) => names.find((n) => view.files.has(n));
  const phpstan = binOf("phpstan/phpstan");
  const psalm = binOf("vimeo/psalm");
  plan.steps.push(
    phpstan && config(["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"])
      ? step("typecheck", sh(`php ${phpstan} analyse --no-progress --no-interaction`), 10 * MIN)
      : psalm && config(["psalm.xml", "psalm.xml.dist"])
        ? step("typecheck", sh(`php ${psalm} --no-progress`), 10 * MIN)
        : skip(
            "typecheck",
            "gap",
            "no type checker (PHPStan or Psalm, with its config file) in composer.lock",
          ),
  );
  const csFixer = binOf("friendsofphp/php-cs-fixer");
  const phpcs = binOf("squizlabs/php_codesniffer");
  plan.steps.push(
    csFixer
      ? step("lint", sh(`php ${csFixer} check --no-interaction`), 5 * MIN)
      : phpcs
        ? step("lint", sh(`php ${phpcs}`), 5 * MIN)
        : skip("lint", "gap", "no linter (PHP-CS-Fixer, PHP_CodeSniffer) in composer.lock"),
  );
  const pest = binOf("pestphp/pest");
  const phpunit = binOf("phpunit/phpunit");
  const unitConfig = config(["phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml"]);
  plan.steps.push(
    pest
      ? { ...step("tests", sh(`php ${pest} --colors=never`), 10 * MIN), gapWhen: sandboxLimits }
      : phpunit
        ? {
            ...step(
              "tests",
              sh(`php ${phpunit} --colors=never${unitConfig ? "" : " tests"}`),
              10 * MIN,
            ),
            gapWhen: sandboxLimits,
          }
        : skip("tests", "gap", "no test runner (PHPUnit or Pest) in composer.lock"),
  );
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
  if (view.files.has("Gemfile")) return rubyPlan(view);
  if (view.files.has("pom.xml")) return mavenPlan(view);
  if (view.files.has("build.gradle") || view.files.has("build.gradle.kts"))
    return refusedEcosystem(
      "not run: Gradle evaluates the build script (code) to resolve dependencies, so the dependency download would run project code",
    );
  if (view.files.has("Cargo.toml")) return rustPlan(view);
  if (view.files.has("composer.json")) return phpPlan(view);
  return refusedEcosystem(
    "no supported manifest (package.json, requirements.txt, pyproject.toml, go.mod, Gemfile, pom.xml, Cargo.toml, composer.json) at the project root",
  );
}
