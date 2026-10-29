import { posix } from "node:path";

export type Ecosystem = "npm" | "PyPI" | "Go" | "RubyGems" | "Maven" | "crates.io" | "Packagist";

export interface LockedPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** `package-lock.json` or `requirements.txt:2`. */
  locator: string;
  dev: boolean;
  /** Where the package manager would download it from, when the lockfile says. */
  resolved: string | null;
}

export interface LockfileParse {
  file: string;
  ecosystem: Ecosystem;
  packages: LockedPackage[];
  /** Lines or entries that could not be read as a pinned package (e.g. `-e .`, ranges). */
  unpinned: { locator: string; text: string }[];
}

/** Lockfile names we read, by basename. */
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "uv.lock",
  // ADR 0026. go.mod lists every module the build selects (Go ≥ 1.17); pom.xml and
  // build.gradle list direct dependencies only.
  "go.mod",
  "Gemfile.lock",
  "gradle.lockfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  // ADR 0028.
  "Cargo.lock",
  "composer.lock",
] as const;

/** Lockfiles that pin direct dependencies only, so transitive ones go unaudited. */
export function directOnly(p: LockfileParse): boolean {
  const base = posix.basename(p.file);
  return (
    (p.ecosystem === "PyPI" && p.file.endsWith(".txt")) ||
    base === "pom.xml" ||
    base.startsWith("build.gradle")
  );
}

const REQUIREMENTS =
  /(^|\/)(requirements[^/]*\.txt|requirements\/[^/]+\.txt|constraints[^/]*\.txt)$/;

export function isLockfile(path: string): boolean {
  const base = posix.basename(path);
  return (LOCKFILES as readonly string[]).includes(base) || REQUIREMENTS.test(path);
}

/** PEP 503 name normalization. */
export const normalizePyName = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");

function npmLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "npm", packages: [], unpinned: [] };
  const data = JSON.parse(text) as {
    packages?: Record<
      string,
      { version?: string; dev?: boolean; resolved?: string; name?: string; link?: boolean }
    >;
    dependencies?: Record<string, { version?: string; dev?: boolean; resolved?: string }>;
  };
  if (data.packages) {
    for (const [key, p] of Object.entries(data.packages)) {
      if (!key || p.link || !p.version) continue;
      const idx = key.lastIndexOf("node_modules/");
      const name = p.name ?? (idx >= 0 ? key.slice(idx + "node_modules/".length) : key);
      out.packages.push({
        ecosystem: "npm",
        name,
        version: p.version,
        locator: file,
        dev: p.dev === true,
        resolved: p.resolved ?? null,
      });
    }
  } else if (data.dependencies) {
    // lockfileVersion 1
    const walkDeps = (
      deps: Record<
        string,
        { version?: string; dev?: boolean; resolved?: string; dependencies?: never }
      >,
    ) => {
      for (const [name, p] of Object.entries(deps)) {
        if (p.version)
          out.packages.push({
            ecosystem: "npm",
            name,
            version: p.version,
            locator: file,
            dev: p.dev === true,
            resolved: p.resolved ?? null,
          });
        if (p.dependencies) walkDeps(p.dependencies);
      }
    };
    walkDeps(data.dependencies);
  }
  return out;
}

function pnpmLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "npm", packages: [], unpinned: [] };
  let inPackages = false;
  text.split("\n").forEach((line) => {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      return;
    }
    if (/^\S/.test(line)) inPackages = false;
    if (!inPackages) return;
    // v9: "  /name@1.2.3:" or "  'name@1.2.3':" or "  name@1.2.3(peer@x):"
    const m = /^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^@\s'"]+)@([^('":\s]+)/.exec(line);
    if (m)
      out.packages.push({
        ecosystem: "npm",
        name: m[1] as string,
        version: m[2] as string,
        locator: file,
        dev: false,
        resolved: null,
      });
  });
  return out;
}

function yarnLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "npm", packages: [], unpinned: [] };
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const head = /^"?((?:@[^/@\s]+\/)?[^@\s"]+)@[^:]*:\s*$/.exec(line);
    if (head) {
      current = head[1] as string;
      continue;
    }
    const v = /^ {2}version:? "?([^"\s]+)"?/.exec(line);
    if (v && current) {
      out.packages.push({
        ecosystem: "npm",
        name: current,
        version: v[1] as string,
        locator: file,
        dev: false,
        resolved: null,
      });
      current = null;
    }
  }
  return out;
}

function tomlPackages(file: string, text: string): LockfileParse {
  // poetry.lock and uv.lock: [[package]] blocks with name = "x" and version = "1.2.3".
  const out: LockfileParse = { file, ecosystem: "PyPI", packages: [], unpinned: [] };
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version)
      out.packages.push({
        ecosystem: "PyPI",
        name: normalizePyName(name),
        version,
        locator: file,
        dev: false,
        resolved: null,
      });
  }
  return out;
}

/** `name==1.2.3` lines (with optional extras, markers and hashes); anything else is unpinned. */
function requirements(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "PyPI", packages: [], unpinned: [] };
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) return;
    const locator = `${file}:${i + 1}`;
    if (line.endsWith("\\")) {
      out.unpinned.push({ locator, text: line });
      return;
    }
    const m =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)\s*(;.*)?$/.exec(
        line.replace(/\s+--hash=\S+/g, ""),
      );
    if (m) {
      out.packages.push({
        ecosystem: "PyPI",
        name: normalizePyName(m[1] as string),
        version: m[3] as string,
        locator,
        dev: /dev|test/i.test(file),
        resolved: null,
      });
    } else {
      out.unpinned.push({ locator, text: line });
    }
  });
  return out;
}

/**
 * go.mod `require` lines (block and single form) are the module versions the build selects.
 * `replace` to a local path takes a module out of the audit; to another module, audits that.
 */
function goMod(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "Go", packages: [], unpinned: [] };
  const replaced = new Map<string, { name: string; version: string } | null>();
  const lines = text.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim());
  let block: "require" | "replace" | null = null;
  const requires: { name: string; version: string; line: number; indirect: boolean }[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = lines[i] as string;
    const open = /^(require|replace)\s*\($/.exec(line);
    if (open) {
      block = open[1] as "require" | "replace";
      return;
    }
    if (block && line === ")") {
      block = null;
      return;
    }
    const body = block ? line : line.replace(/^(require|replace)\s+/, "");
    const kind = block ?? /^(require|replace)\s/.exec(line)?.[1];
    if (kind === "require") {
      const m = /^(\S+)\s+(v\S+)$/.exec(body);
      if (m)
        requires.push({
          name: m[1] as string,
          version: m[2] as string,
          line: i + 1,
          indirect: /\/\/\s*indirect/.test(raw),
        });
    } else if (kind === "replace") {
      const m = /^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)(?:\s+(v\S+))?$/.exec(body);
      if (m) replaced.set(m[1] as string, m[3] ? { name: m[2] as string, version: m[3] } : null);
    }
  });
  for (const r of requires) {
    const locator = `${file}:${r.line}`;
    const rep = replaced.has(r.name) ? replaced.get(r.name) : undefined;
    if (rep === null) {
      out.unpinned.push({ locator, text: `${r.name} (replaced by a local directory)` });
      continue;
    }
    out.packages.push({
      ecosystem: "Go",
      name: rep?.name ?? r.name,
      version: rep?.version ?? r.version,
      locator,
      dev: false,
      resolved: null,
    });
  }
  return out;
}

/** Gemfile.lock: the `specs:` entries of each GEM section (`    name (1.2.3[-platform])`). */
function gemfileLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "RubyGems", packages: [], unpinned: [] };
  let section = "";
  let inSpecs = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\S/.test(raw)) {
      section = raw.trim();
      inSpecs = false;
      return;
    }
    if (/^ {2}specs:\s*$/.test(raw)) {
      inSpecs = true;
      return;
    }
    if (!inSpecs) return;
    const m = /^ {4}([A-Za-z0-9._-]+) \(([^)]+)\)\s*$/.exec(raw);
    if (!m) return;
    const locator = `${file}:${i + 1}`;
    if (section !== "GEM") {
      out.unpinned.push({ locator, text: `${m[1]} (${section.toLowerCase()} source)` });
      return;
    }
    out.packages.push({
      ecosystem: "RubyGems",
      name: m[1] as string,
      // `nokogiri (1.16.0-x86_64-linux)`: the platform is not part of the version.
      version: (m[2] as string).replace(
        /-(x86|x64|arm|aarch|universal|java|mingw|darwin|linux).*$/,
        "",
      ),
      locator,
      dev: false,
      resolved: null,
    });
  });
  return out;
}

/**
 * Cargo.lock: `[[package]]` blocks. Packages without a `source` are the workspace's own crates;
 * a git source is not a crates.io release, so it is listed as unpinned.
 */
function cargoLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "crates.io", packages: [], unpinned: [] };
  const lines = text.split("\n");
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const block = lines.slice(start, end).join("\n");
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const source = /^source\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const nameLine = lines.slice(start, end).findIndex((l) => /^name\s*=/.test(l));
    const locator = `${file}:${start + Math.max(nameLine, 0) + 1}`;
    if (!name || !version || !source) return;
    if (
      /^(registry|sparse)\+https:\/\/(github\.com\/rust-lang\/crates\.io-index|index\.crates\.io\/)/.test(
        source,
      )
    )
      out.packages.push({
        ecosystem: "crates.io",
        name,
        version,
        locator,
        dev: false,
        resolved: null,
      });
    else
      out.unpinned.push({ locator, text: `${name} ${version} (${source.split("+")[0]} source)` });
  };
  lines.forEach((l, i) => {
    if (/^\[\[package\]\]\s*$/.test(l)) {
      flush(i);
      start = i + 1;
    } else if (/^\[/.test(l)) {
      flush(i);
      start = -1;
    }
  });
  flush(lines.length);
  return out;
}

/** composer.lock: `packages` and `packages-dev`; a `dev-…` branch is not a release. */
function composerLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "Packagist", packages: [], unpinned: [] };
  const doc = JSON.parse(text) as Record<string, { name?: string; version?: string }[] | undefined>;
  const lines = text.split("\n");
  for (const key of ["packages", "packages-dev"]) {
    for (const pkg of doc[key] ?? []) {
      if (!pkg.name || !pkg.version) continue;
      const at = lines.findIndex((l) => l.includes(`"name": ${JSON.stringify(pkg.name)}`));
      const locator = at >= 0 ? `${file}:${at + 1}` : file;
      if (/^dev-|-dev$/.test(pkg.version)) {
        out.unpinned.push({ locator, text: `${pkg.name} ${pkg.version} (branch)` });
        continue;
      }
      out.packages.push({
        ecosystem: "Packagist",
        name: pkg.name,
        // Composer locks tags as written (`v4.12.0`); OSV ranges use the bare version.
        version: pkg.version.replace(/^v/, ""),
        locator,
        dev: key === "packages-dev",
        resolved: null,
      });
    }
  }
  return out;
}

/** gradle.lockfile: `group:artifact:version=configurations`. */
function gradleLock(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "Maven", packages: [], unpinned: [] };
  text.split("\n").forEach((raw, i) => {
    const m = /^([\w.-]+):([\w.-]+):([\w.+-]+)=(.*)$/.exec(raw.trim());
    if (m)
      out.packages.push({
        ecosystem: "Maven",
        name: `${m[1]}:${m[2]}`,
        version: m[3] as string,
        locator: `${file}:${i + 1}`,
        // Test-only when every configuration it is on is a test one.
        dev: (m[4] as string).split(",").every((c) => /^test/i.test(c.trim())),
        resolved: null,
      });
  });
  return out;
}

/** pom.xml `<dependency>` entries with a literal (or `${property}`) version. */
function pomXml(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "Maven", packages: [], unpinned: [] };
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const props = new Map<string, string>();
  const propBlock = /<properties>([\s\S]*?)<\/properties>/.exec(xml)?.[1] ?? "";
  for (const m of propBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g))
    props.set(m[1] as string, m[2] as string);
  const lineAt = (idx: number) => xml.slice(0, idx).split("\n").length;
  const tag = (body: string, name: string) =>
    new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(body)?.[1] ?? null;
  for (const m of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = m[1] as string;
    const g = tag(body, "groupId");
    const a = tag(body, "artifactId");
    if (!g || !a) continue;
    // The <artifactId> line names the package.
    const locator = `${file}:${lineAt((m.index ?? 0) + Math.max(0, m[0].indexOf("<artifactId>")))}`;
    let v = tag(body, "version");
    const ref = v ? /^\$\{([\w.-]+)\}$/.exec(v) : null;
    if (ref) v = props.get(ref[1] as string) ?? null;
    if (!v || /[[(,$]/.test(v)) {
      out.unpinned.push({
        locator,
        text: `${g}:${a} (${v ? "version range" : "version set by the parent POM or a BOM"})`,
      });
      continue;
    }
    out.packages.push({
      ecosystem: "Maven",
      name: `${g}:${a}`,
      version: v,
      locator,
      dev: tag(body, "scope") === "test",
      resolved: null,
    });
  }
  return out;
}

/** build.gradle(.kts) string-notation dependencies with a version (`"g:a:1.2.3"`). */
function gradleBuild(file: string, text: string): LockfileParse {
  const out: LockfileParse = { file, ecosystem: "Maven", packages: [], unpinned: [] };
  text.split("\n").forEach((raw, i) => {
    const m =
      /^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(?\s*["']([\w.-]+):([\w.-]+)(?::([^"']+))?["']/.exec(
        raw,
      );
    if (!m) return;
    const locator = `${file}:${i + 1}`;
    const v = m[4];
    if (!v || /[[(,+$]/.test(v)) {
      out.unpinned.push({ locator, text: `${m[2]}:${m[3]} (no fixed version)` });
      return;
    }
    out.packages.push({
      ecosystem: "Maven",
      name: `${m[2]}:${m[3]}`,
      version: v,
      locator,
      dev: /^test/.test(m[1] as string),
      resolved: null,
    });
  });
  return out;
}

export function parseLockfile(path: string, text: string): LockfileParse | null {
  const base = posix.basename(path);
  try {
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return npmLock(path, text);
    if (base === "pnpm-lock.yaml") return pnpmLock(path, text);
    if (base === "yarn.lock") return yarnLock(path, text);
    if (base === "poetry.lock" || base === "uv.lock") return tomlPackages(path, text);
    if (base === "go.mod") return goMod(path, text);
    if (base === "Gemfile.lock") return gemfileLock(path, text);
    if (base === "gradle.lockfile") return gradleLock(path, text);
    if (base === "pom.xml") return pomXml(path, text);
    if (base === "build.gradle" || base === "build.gradle.kts") return gradleBuild(path, text);
    if (base === "Cargo.lock") return cargoLock(path, text);
    if (base === "composer.lock") return composerLock(path, text);
    if (REQUIREMENTS.test(path)) return requirements(path, text);
  } catch {
    return null;
  }
  return null;
}
