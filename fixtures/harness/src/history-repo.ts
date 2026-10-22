import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Generates the git-history fixture (ADR 0006: a nested `.git` cannot be committed, so it
 * is built on demand). Authors and dates are fixed, so the history is identical on every
 * run. Expected analysis: 8 commits, 2 contributors; `src/core.ts` and `src/api.ts`
 * co-change in 6 commits (the initial commit included); `src/core.ts` is the only hotspot (highest churn, imported by
 * all ten feature files).
 */
export const HISTORY_EXPECTED = {
  commits: 8,
  contributors: 2,
  coChange: { a: "src/api.ts", b: "src/core.ts", count: 6 },
  hotspots: ["src/core.ts"],
} as const;

export function createHistoryRepo(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...env,
      },
      stdio: "pipe",
    });
  const commit = (n: number, author: string, msg: string) => {
    const date = `2026-01-${String(n).padStart(2, "0")}T12:00:00Z`;
    run(["add", "-A"]);
    run(
      [
        "-c",
        `user.name=${author}`,
        "-c",
        `user.email=${author}@example.com`,
        "commit",
        "-q",
        "-m",
        msg,
      ],
      {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    );
  };
  const write = (p: string, s: string) => writeFileSync(join(dir, p), s);

  run(["init", "-q", "-b", "main"]);
  write("README.md", "# history fixture\n");
  write("src/core.ts", "export const version = 1;\n");
  write("src/api.ts", 'import { version } from "./core.ts";\nexport const api = () => version;\n');
  for (let i = 1; i <= 10; i++)
    write(
      `src/f${i}.ts`,
      `import { version } from "./core.ts";\nexport const f${i} = () => version + ${i};\n`,
    );
  commit(1, "ana", "initial");
  for (let n = 2; n <= 6; n++) {
    write("src/core.ts", `export const version = ${n};\n`);
    write(
      "src/api.ts",
      `import { version } from "./core.ts";\nexport const api = () => version * ${n};\n`,
    );
    commit(n, n % 2 ? "ana" : "bo", `core and api ${n}`);
  }
  write("src/core.ts", "export const version = 7;\n");
  commit(7, "bo", "core only");
  write("README.md", "# history fixture\n\nUpdated.\n");
  commit(8, "ana", "docs");
  return dir;
}
