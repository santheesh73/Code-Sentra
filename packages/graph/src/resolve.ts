import { posix } from "node:path";

/** tsconfig `compilerOptions.paths` mapping, with `baseUrl` already applied (repo-relative). */
export type PathAliases = { pattern: string; targets: string[] }[];

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
/** ESM-style imports name the emitted file (`./x.js`) for a source `./x.ts`. */
const EMIT_TO_SOURCE: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function candidates(base: string): string[] {
  const out = [base];
  const ext = posix.extname(base);
  for (const src of EMIT_TO_SOURCE[ext] ?? []) out.push(base.slice(0, -ext.length) + src);
  for (const e of JS_EXTS) out.push(base + e);
  for (const e of JS_EXTS) out.push(posix.join(base, `index${e}`));
  return out;
}

const norm = (p: string) => posix.normalize(p).replace(/^\.\//, "");

/**
 * Resolves a JS/TS import specifier to a repo file, or null for packages and unresolvable
 * specifiers. Handles relative paths, emitted-extension imports, index files, and
 * tsconfig `paths` aliases.
 */
export function resolveJsImport(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
  aliases: PathAliases = [],
): string | null {
  const tryAll = (base: string) => {
    for (const c of candidates(norm(base))) if (!c.startsWith("..") && files.has(c)) return c;
    return null;
  };
  if (specifier.startsWith(".")) return tryAll(posix.join(posix.dirname(fromFile), specifier));
  if (specifier.startsWith("/")) return tryAll(specifier.slice(1));
  for (const { pattern, targets } of aliases) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (specifier !== pattern) continue;
      for (const t of targets) {
        const hit = tryAll(t);
        if (hit) return hit;
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const mid = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const t of targets) {
      const hit = tryAll(t.replace("*", mid));
      if (hit) return hit;
    }
  }
  return null;
}

/** Reads `paths` and `baseUrl` from a parsed tsconfig located at `tsconfigPath`. */
export function aliasesFromTsconfig(tsconfigPath: string, config: unknown): PathAliases {
  const opts = (
    config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
  )?.compilerOptions;
  if (!opts?.paths) return [];
  const root = posix.dirname(tsconfigPath);
  const base = posix.join(root, opts.baseUrl ?? ".");
  return Object.entries(opts.paths).map(([pattern, targets]) => ({
    pattern,
    targets: (Array.isArray(targets) ? targets : []).map((t) => norm(posix.join(base, t))),
  }));
}

/**
 * Resolves a Python module (`notes_api.store`, or `.store` relative to a package) to a repo
 * file. Absolute modules are searched under each source root (the repo root, `src/`, …).
 */
export function resolvePyImport(
  fromFile: string,
  module: string,
  files: ReadonlySet<string>,
  roots: string[] = ["", "src"],
): string | null {
  const tryBase = (base: string) => {
    for (const c of [`${base}.py`, `${base}/__init__.py`]) {
      const n = norm(c);
      if (files.has(n)) return n;
    }
    return null;
  };
  const dots = /^\.+/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).replace(/\./g, "/");
  if (dots > 0) {
    let dir = posix.dirname(fromFile);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    return tryBase(rest ? posix.join(dir, rest) : dir);
  }
  for (const root of roots) {
    const hit = tryBase(root ? posix.join(root, rest) : rest);
    if (hit) return hit;
  }
  return null;
}
