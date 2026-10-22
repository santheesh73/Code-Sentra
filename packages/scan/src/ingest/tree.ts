import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TreeEntry {
  path: string;
  size: number;
}

export interface TreeListing {
  files: TreeEntry[];
  /** Symlinks are never followed (a link to /etc/passwd must not be read). */
  skippedSymlinks: string[];
}

/** Lists regular files under `root`, repo-relative with `/`, sorted; `.git/` is excluded. */
export async function listTree(root: string): Promise<TreeListing> {
  const files: TreeEntry[] = [];
  const skippedSymlinks: string[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop() as string;
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        skippedSymlinks.push(p);
        continue;
      }
      if (e.isDirectory()) {
        if (!rel && e.name === ".git") continue;
        stack.push(p);
      } else if (e.isFile()) {
        files.push({ path: p, size: (await lstat(join(root, p))).size });
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skippedSymlinks: skippedSymlinks.sort() };
}

function fileHash(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });
}

/**
 * Content identity of a tree: sha256 over sorted `path\0sha256(content)\n` lines. Two
 * snapshots with the same hash have identical files, so a successful scan can be reused.
 */
export async function treeHash(root: string, files: TreeEntry[]): Promise<string> {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.path}\u0000${await fileHash(join(root, f.path))}\n`);
  return h.digest("hex");
}

/** Directories that hold installed or generated code, not the project's own source. */
export const VENDORED_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".tox",
]);

export function isVendored(path: string): boolean {
  return path.split("/").some((s) => VENDORED_DIRS.has(s));
}
