import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLockSources, urlProblem } from "./index.js";

const FIXTURES = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../test-fixtures/lock-sources",
);
const cases = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8")) as {
  ecosystem: string;
  case: string;
  file: string;
  refused: string | null;
}[];
const NAMES: Record<string, string> = { poetry: "six", composer: "guzzlehttp/psr7" };

describe("lockfile sources (ADR 0030)", () => {
  it.each(cases.map((c) => [`${c.ecosystem}: ${c.case}`, c] as const))("%s", (_n, c) => {
    const got = checkLockSources(c.file, readFileSync(join(FIXTURES, c.file), "utf8"));
    if (c.refused === null) expect(got).toBeNull();
    else {
      expect(got).toContain(NAMES[c.ecosystem] ?? "is-number");
      expect(got?.toLowerCase()).toContain(c.refused.toLowerCase());
    }
  });
  it("covers every ecosystem with a clean lockfile and hostile ones", () => {
    const eco = new Set(cases.map((c) => c.ecosystem));
    for (const e of eco) {
      expect(cases.some((c) => c.ecosystem === e && c.refused === null)).toBe(true);
      expect(cases.filter((c) => c.ecosystem === e && c.refused !== null).length).toBeGreaterThan(
        5,
      );
    }
    expect([...eco].sort()).toEqual(
      ["composer", "npm", "pnpm-v6", "pnpm-v9", "poetry", "yarn-berry", "yarn-classic"].sort(),
    );
  });
  it("the shared rule: https, default port, no credentials, an allowed host, never an IP", () => {
    const hosts = new Set(["registry.npmjs.org"]);
    expect(urlProblem("https://registry.npmjs.org/x.tgz", hosts)).toBeNull();
    for (const u of [
      "https://[::1]/x.tgz",
      "https://[::ffff:127.0.0.1]/x.tgz",
      "https://2130706433/x.tgz",
      "https://0x7f.0.0.1/x.tgz",
      "https://8.8.8.8/x.tgz",
      "https://registry.npmjs.org.evil.example/x.tgz",
      "ftp://registry.npmjs.org/x.tgz",
      "not a url",
    ])
      expect(urlProblem(u, hosts), u).not.toBeNull();
  });
});
