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

const dirIndexes = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

/** Files by their directory (`""` for the root), built once per file set. */
function filesIn(files: ReadonlySet<string>, dir: string): string[] {
  let index = dirIndexes.get(files);
  if (!index) {
    index = new Map();
    for (const f of files) {
      const d = posix.dirname(f) === "." ? "" : posix.dirname(f);
      const list = index.get(d);
      if (list) list.push(f);
      else index.set(d, [f]);
    }
    dirIndexes.set(files, index);
  }
  return index.get(dir === "." ? "" : dir) ?? [];
}

/** A Go module rooted at `dir` (where its go.mod is), with its declared module path. */
export interface GoModule {
  dir: string;
  module: string;
}

/**
 * Resolves a Go import path to the package's non-test `.go` files: the module whose path
 * prefixes the import (the longest one), then the directory below it. Standard library
 * and third-party packages resolve to nothing.
 */
export function resolveGoImport(
  importPath: string,
  files: ReadonlySet<string>,
  modules: GoModule[],
): string[] {
  const mod = [...modules]
    .sort((a, b) => b.module.length - a.module.length)
    .find((m) => importPath === m.module || importPath.startsWith(`${m.module}/`));
  if (!mod) return [];
  const dir = norm(posix.join(mod.dir || ".", importPath.slice(mod.module.length + 1)));
  return filesIn(files, dir)
    .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    .sort();
}

/**
 * Resolves a Ruby `require_relative` (against the requiring file) or `require` (against
 * `lib/`, `app/` and the repo root, as `$LOAD_PATH` usually holds) to a repo file.
 */
export function resolveRubyRequire(
  fromFile: string,
  spec: string,
  relative: boolean,
  files: ReadonlySet<string>,
  roots: string[] = ["lib", "app", ""],
): string | null {
  const withExt = spec.endsWith(".rb") ? spec : `${spec}.rb`;
  const bases = relative
    ? [posix.join(posix.dirname(fromFile), withExt)]
    : roots.map((r) => (r ? posix.join(r, withExt) : withExt));
  for (const b of bases) {
    const n = norm(b);
    if (files.has(n)) return n;
  }
  return null;
}

/**
 * Resolves a Java import (`a.b.C`, or the package `a.b` of a wildcard import) to files
 * under the source roots (`src/main/java`, `src/test/java`, …).
 */
export function resolveJavaImport(
  name: string,
  wildcard: boolean,
  files: ReadonlySet<string>,
  roots: string[],
): string[] {
  const rel = name.replace(/\./g, "/");
  const out: string[] = [];
  for (const root of roots) {
    const base = root ? `${root}/${rel}` : rel;
    if (wildcard) out.push(...filesIn(files, base).filter((f) => f.endsWith(".java")));
    else if (files.has(`${base}.java`)) out.push(`${base}.java`);
  }
  return [...new Set(out)].sort();
}

/** Java source roots: every `src/main/java`-style directory, else `src` and the root. */
export function javaRootsOf(files: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const f of files) {
    const m = /^(.*?(?:^|\/)src\/(?:main|test)\/java)\//.exec(f);
    if (m) roots.add(m[1] as string);
  }
  return roots.size ? [...roots].sort() : ["src", ""];
}

/** A Cargo package rooted at `dir` (where its Cargo.toml is), by its crate name (`-` → `_`). */
export interface RustCrate {
  dir: string;
  name: string;
}

const RUST_ROOT_DIRS = /(^|\/)(tests|examples|benches|src\/bin)\/[^/]+\.rs$/;

/** The crate a file belongs to: the one whose directory is the file's longest prefix. */
function crateOf(file: string, crates: RustCrate[]): RustCrate | null {
  return (
    [...crates]
      .sort((a, b) => b.dir.length - a.dir.length)
      .find((c) => c.dir === "" || file.startsWith(`${c.dir}/`)) ?? null
  );
}

/** The directory a module's children live in: `src/` for `src/lib.rs`, `src/api/` for `src/api.rs`. */
function rustModuleDir(file: string): string {
  const base = posix.basename(file);
  if (["lib.rs", "main.rs", "mod.rs", "build.rs"].includes(base) || RUST_ROOT_DIRS.test(file))
    return posix.dirname(file) === "." ? "" : posix.dirname(file);
  return file.slice(0, -3);
}

/**
 * Resolves `mod x;` declared in `fromFile` to `x.rs` or `x/mod.rs` in the declaring module's
 * directory.
 */
export function resolveRustMod(
  fromFile: string,
  name: string,
  files: ReadonlySet<string>,
): string | null {
  const dir = rustModuleDir(fromFile);
  for (const c of [`${name}.rs`, `${name}/mod.rs`]) {
    const n = norm(dir ? posix.join(dir, c) : c);
    if (files.has(n)) return n;
  }
  return null;
}

/**
 * Resolves a `use` path (`crate::store::Store`, `super::x`, `my_crate::api`) to the file of the
 * deepest module it names; an item defined in the crate root resolves to `lib.rs`/`main.rs`.
 * Paths into other crates (`std::`, dependencies) resolve to nothing.
 */
export function resolveRustUse(
  fromFile: string,
  path: string,
  files: ReadonlySet<string>,
  crates: RustCrate[],
): string | null {
  const segs = path.split("::");
  const own = crateOf(fromFile, crates);
  let base: string;
  let crate: RustCrate | null;
  const head = segs[0];
  if (head === "crate" || head === "self" || head === "super") {
    crate = own;
    base = head === "crate" ? (own ? posix.join(own.dir, "src") : "src") : rustModuleDir(fromFile);
    segs.shift();
    if (head === "super") {
      base = posix.dirname(base);
      while (segs[0] === "super") {
        segs.shift();
        base = posix.dirname(base);
      }
    }
  } else {
    crate = crates.find((c) => c.name === head) ?? null;
    if (!crate) return null;
    base = posix.join(crate.dir, "src");
    segs.shift();
  }
  base = norm(base);
  for (let k = segs.length; k >= 1; k--) {
    const p = posix.join(base, ...segs.slice(0, k));
    for (const c of [`${p}.rs`, `${p}/mod.rs`]) if (files.has(norm(c))) return norm(c);
  }
  // The item is defined in the module itself.
  const src = crate ? norm(posix.join(crate.dir, "src")) : "src";
  const candidates =
    base === src
      ? fromFile === `${src}/main.rs`
        ? [`${src}/main.rs`]
        : [`${src}/lib.rs`, `${src}/main.rs`]
      : [`${base}.rs`, `${base}/mod.rs`];
  return candidates.find((c) => files.has(c) && c !== fromFile) ?? null;
}

/** A PSR-4 autoload entry: namespace prefix (`App\`) → directory (repo-relative). */
export interface PhpAutoload {
  prefix: string;
  dir: string;
}

/** Reads `autoload` and `autoload-dev` PSR-4 maps from a parsed composer.json at `file`. */
export function psr4FromComposer(file: string, json: unknown): PhpAutoload[] {
  const root = posix.dirname(file) === "." ? "" : posix.dirname(file);
  const out: PhpAutoload[] = [];
  const doc = json as Record<string, { "psr-4"?: Record<string, string | string[]> } | undefined>;
  for (const key of ["autoload", "autoload-dev"])
    for (const [prefix, dirs] of Object.entries(doc?.[key]?.["psr-4"] ?? {}))
      for (const d of Array.isArray(dirs) ? dirs : [dirs])
        if (typeof d === "string")
          out.push({
            prefix: prefix.replace(/^\\/, ""),
            dir: norm(posix.join(root || ".", d)).replace(/\/$/, ""),
          });
  return out;
}

/** Resolves a `use`d PHP class (`App\Store\Notes`) through the PSR-4 map (longest prefix first). */
export function resolvePhpUse(
  name: string,
  files: ReadonlySet<string>,
  autoload: PhpAutoload[],
): string | null {
  const cls = name.replace(/^\\/, "");
  for (const { prefix, dir } of [...autoload].sort((a, b) => b.prefix.length - a.prefix.length)) {
    if (!cls.startsWith(prefix)) continue;
    const rel = `${cls.slice(prefix.length).replace(/\\/g, "/")}.php`;
    const p = norm(dir && dir !== "." ? posix.join(dir, rel) : rel);
    if (files.has(p)) return p;
  }
  return null;
}

/** Resolves a `require`/`include` path against the requiring file's directory. */
export function resolvePhpRequire(
  fromFile: string,
  spec: string,
  files: ReadonlySet<string>,
): string | null {
  const p = norm(posix.join(posix.dirname(fromFile), spec));
  return !p.startsWith("..") && files.has(p) ? p : null;
}
