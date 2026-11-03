import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The networked dependency download sees only what this module lets through (ADR 0030): the
 * dependency manifests and lockfiles, by exact file name, copied into a fresh, empty directory.
 * Nothing else from the repository is there, so no project configuration, script or hook can
 * take part in the download.
 */

/** File names a dependency download may read, wherever they sit in the tree. */
export const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.json",
  "composer.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "pom.xml",
  "Cargo.toml",
  "Cargo.lock",
]);

/** Directories never copied: installed dependencies and version-control data. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "target", "bower_components"]);

/**
 * Cargo discovers a package's targets from the files that exist (`src/lib.rs`, `src/main.rs`,
 * `src/bin/*.rs`, …). The download keeps that layout with empty placeholders, so manifests
 * resolve the same way while no source text is present.
 */
const RUST_SOURCE = /\.rs$/;

export interface FetchDirPlan {
  /** Repository files copied byte for byte. */
  copy: string[];
  /** Empty placeholder files (Rust target layout only). */
  placeholders: string[];
}

/** Whether every path segment is a plain name: none hidden, none a skipped directory. */
function plainPath(path: string): boolean {
  const parts = path.split("/");
  return parts.every(
    (p, i) => p !== "" && !p.startsWith(".") && (i === parts.length - 1 || !SKIP_DIRS.has(p)),
  );
}

/** Pure: which snapshot paths go into the download directory. */
export function planFetchDir(paths: Iterable<string>): FetchDirPlan {
  const all = [...paths].filter(plainPath);
  const copy = all.filter((p) => MANIFEST_NAMES.has(p.slice(p.lastIndexOf("/") + 1)));
  const rust = copy.some((p) => p.endsWith("Cargo.toml"));
  const placeholders = rust ? all.filter((p) => RUST_SOURCE.test(p)) : [];
  return { copy: copy.sort(), placeholders: placeholders.sort() };
}

/**
 * Creates the download directory from a plan (the directory must not exist yet). Only
 * regular files are copied: a symlink named like a manifest is left out.
 */
export async function materializeFetchDir(
  sourceDir: string,
  destDir: string,
  plan: FetchDirPlan,
): Promise<void> {
  await mkdir(destDir, { recursive: false });
  for (const p of plan.copy) {
    if (!(await lstat(join(sourceDir, p))).isFile()) continue;
    await mkdir(dirname(join(destDir, p)), { recursive: true });
    await copyFile(join(sourceDir, p), join(destDir, p));
  }
  for (const p of plan.placeholders) {
    await mkdir(dirname(join(destDir, p)), { recursive: true });
    await writeFile(join(destDir, p), "");
  }
}
