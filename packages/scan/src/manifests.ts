import { posix } from "node:path";

/** What a Go, Ruby or JVM manifest declares; parsed as text, never evaluated. */
export interface ManifestInfo {
  file: string;
  ecosystem: "go" | "ruby" | "maven" | "gradle" | "rust" | "php";
  packageManager: "go" | "bundler" | "maven" | "gradle" | "cargo" | "composer";
  /** The Go module path, the Maven `groupId:artifactId`, the Cargo or Composer package name, or null. */
  name: string | null;
  version: string | null;
  description: string | null;
  /** Dependency name → declared version (or `*`). */
  dependencies: Record<string, string>;
}

/** Manifest file names the map stage reads for the languages added in ADR 0026 and ADR 0028. */
export const MANIFEST_FILE =
  /(^|\/)(go\.mod|go\.sum|Gemfile|Gemfile\.lock|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|settings\.gradle(\.kts)?|Cargo\.toml|Cargo\.lock|composer\.json|composer\.lock)$/;

/** `module x` and the `require` lines (single and block form) of a go.mod. */
export function parseGoMod(file: string, text: string): ManifestInfo {
  const deps: Record<string, string> = {};
  let inRequire = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const m = (inRequire ? /^(\S+)\s+(v\S+)$/ : /^require\s+(\S+)\s+(v\S+)$/).exec(line);
    if (m) deps[m[1] as string] = m[2] as string;
  }
  return {
    file,
    ecosystem: "go",
    packageManager: "go",
    name: /^module\s+(\S+)/m.exec(text)?.[1] ?? null,
    version: /^go\s+(\S+)/m.exec(text)?.[1] ?? null,
    description: null,
    dependencies: deps,
  };
}

/** `gem "name", "~> 1.2"` lines of a Gemfile (read as text; a Gemfile is Ruby and never run). */
export function parseGemfile(file: string, text: string): ManifestInfo {
  const deps: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm))
    deps[m[1] as string] = m[2] ?? "*";
  return {
    file,
    ecosystem: "ruby",
    packageManager: "bundler",
    name: null,
    version: null,
    description: null,
    dependencies: deps,
  };
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] ?? null;

/** A pom.xml's own coordinates and `<dependency>` entries (literal versions as written). */
export function parsePom(file: string, text: string): ManifestInfo {
  const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const deps: Record<string, string> = {};
  for (const m of noComments.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = m[1] as string;
    const g = tag(body, "groupId");
    const a = tag(body, "artifactId");
    if (g && a) deps[`${g}:${a}`] = tag(body, "version") ?? "*";
  }
  // The project's own coordinates sit outside <parent>, <dependencies> and <build>.
  const top = noComments
    .replace(/<parent>[\s\S]*?<\/parent>/g, "")
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "")
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
    .replace(/<build>[\s\S]*?<\/build>/g, "");
  const g = tag(top, "groupId");
  const a = tag(top, "artifactId");
  return {
    file,
    ecosystem: "maven",
    packageManager: "maven",
    name: g && a ? `${g}:${a}` : a,
    version: tag(top, "version"),
    description: tag(top, "description"),
    dependencies: deps,
  };
}

/** `implementation "g:a:v"` style dependencies of a build.gradle(.kts), read as text. */
export function parseGradle(file: string, text: string): ManifestInfo {
  const deps: Record<string, string> = {};
  for (const m of text.matchAll(
    /^\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)\s*\(?\s*["']([\w.-]+):([\w.-]+)(?::([\w.+-]+))?["']/gm,
  ))
    deps[`${m[1]}:${m[2]}`] = m[3] ?? "*";
  return {
    file,
    ecosystem: "gradle",
    packageManager: "gradle",
    name: null,
    version: null,
    description: null,
    dependencies: deps,
  };
}

/** The `key = value` lines of one TOML table, up to the next `[header]`. */
function tomlTable(text: string, header: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) {
      inside = h[1]?.trim() === header;
      continue;
    }
    if (inside && line) out.push(line);
  }
  return out;
}
const tomlString = (lines: string[], key: string) =>
  lines
    .map((l) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(l)?.[1])
    .find((v) => v !== undefined) ?? null;

/**
 * A Cargo.toml's `[package]` and its dependency tables, read as text: `name = "1.0"`,
 * `name = { version = "1.0", … }`, or a `[dependencies.name]` table. A path or git dependency
 * without a version is `*`.
 */
export function parseCargoToml(file: string, text: string): ManifestInfo {
  const pkg = tomlTable(text, "package");
  const deps: Record<string, string> = {};
  for (const table of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    for (const line of tomlTable(text, table)) {
      const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      const v = m[2] as string;
      deps[m[1] as string] =
        /^"([^"]*)"/.exec(v)?.[1] ?? /\bversion\s*=\s*"([^"]*)"/.exec(v)?.[1] ?? "*";
    }
  }
  for (const m of text.matchAll(/^\[(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)\]\s*$/gm)) {
    const name = m[1] as string;
    deps[name] = tomlString(tomlTable(text, m[0].trim().slice(1, -1)), "version") ?? "*";
  }
  return {
    file,
    ecosystem: "rust",
    packageManager: "cargo",
    name: tomlString(pkg, "name"),
    version: tomlString(pkg, "version"),
    description: tomlString(pkg, "description"),
    dependencies: deps,
  };
}

/** A composer.json's name, description and `require`/`require-dev` (platform `php`/`ext-*` left out). */
export function parseComposerJson(file: string, text: string): ManifestInfo | null {
  let doc: {
    name?: string;
    version?: string;
    description?: string;
    require?: Record<string, string>;
    "require-dev"?: Record<string, string>;
  };
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const deps: Record<string, string> = {};
  for (const [n, v] of Object.entries({ ...doc.require, ...doc["require-dev"] }))
    if (n.includes("/")) deps[n] = typeof v === "string" ? v : "*";
  return {
    file,
    ecosystem: "php",
    packageManager: "composer",
    name: doc.name ?? null,
    version: doc.version ?? null,
    description: doc.description ?? null,
    dependencies: deps,
  };
}

/** Parses a manifest by file name; null when it is not one (or is a lock/sum file). */
export function parseManifest(path: string, text: string): ManifestInfo | null {
  const base = posix.basename(path);
  if (base === "go.mod") return parseGoMod(path, text);
  if (base === "Gemfile") return parseGemfile(path, text);
  if (base === "pom.xml") return parsePom(path, text);
  if (base === "build.gradle" || base === "build.gradle.kts") return parseGradle(path, text);
  if (base === "Cargo.toml") return parseCargoToml(path, text);
  if (base === "composer.json") return parseComposerJson(path, text);
  return null;
}
