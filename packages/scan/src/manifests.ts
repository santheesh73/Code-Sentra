import { posix } from "node:path";

/** What a Go, Ruby or JVM manifest declares; parsed as text, never evaluated. */
export interface ManifestInfo {
  file: string;
  ecosystem: "go" | "ruby" | "maven" | "gradle";
  packageManager: "go" | "bundler" | "maven" | "gradle";
  /** The Go module path, the Maven `groupId:artifactId`, or null. */
  name: string | null;
  version: string | null;
  /** Dependency name → declared version (or `*`). */
  dependencies: Record<string, string>;
}

/** Manifest file names the map stage reads for the languages added in ADR 0026. */
export const MANIFEST_FILE =
  /(^|\/)(go\.mod|go\.sum|Gemfile|Gemfile\.lock|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|settings\.gradle(\.kts)?)$/;

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
  return null;
}
