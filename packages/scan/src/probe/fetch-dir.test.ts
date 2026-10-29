import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { materializeFetchDir, planFetchDir } from "./fetch-dir.js";

const FIXTURE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../test-fixtures/fetch-dir/tree.json",
);
const tree = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  paths: string[];
  expected: { copy: string[]; placeholders: string[] };
};
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("manifest-only download directory (ADR 0030)", () => {
  it("lets through only manifests and lockfiles, outside hidden and installed directories", () => {
    expect(planFetchDir(tree.paths)).toEqual(tree.expected);
  });
  it("adds no Rust placeholders when there is no Cargo.toml", () => {
    expect(planFetchDir(["package.json", "tools/gen.rs"]).placeholders).toEqual([]);
  });
  it("copies exactly the plan into a fresh directory, placeholders empty, symlinks left out", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-fetchdir-"));
    scratch.push(root);
    const src = join(root, "src");
    for (const p of tree.paths) {
      mkdirSync(dirname(join(src, p)), { recursive: true });
      writeFileSync(join(src, p), `content of ${p}`);
    }
    mkdirSync(join(src, "linked"));
    symlinkSync("/etc/hostname", join(src, "linked/package.json"));
    const plan = planFetchDir([...tree.paths, "linked/package.json"]);
    const dest = join(root, "fetch");
    await materializeFetchDir(src, dest, plan);
    const got = walk(dest)
      .map((p) => relative(dest, p))
      .sort();
    expect(got).toEqual([...tree.expected.copy, ...tree.expected.placeholders].sort());
    expect(readFileSync(join(dest, "package.json"), "utf8")).toBe("content of package.json");
    expect(readFileSync(join(dest, "src/main.rs"), "utf8")).toBe("");
    await expect(materializeFetchDir(src, dest, plan)).rejects.toThrow();
  });
});
