import { posix } from "node:path";

export type Ecosystem = "npm" | "PyPI";

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
] as const;

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

export function parseLockfile(path: string, text: string): LockfileParse | null {
  const base = posix.basename(path);
  try {
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return npmLock(path, text);
    if (base === "pnpm-lock.yaml") return pnpmLock(path, text);
    if (base === "yarn.lock") return yarnLock(path, text);
    if (base === "poetry.lock" || base === "uv.lock") return tomlPackages(path, text);
    if (REQUIREMENTS.test(path)) return requirements(path, text);
  } catch {
    return null;
  }
  return null;
}
