import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Locator = z.string().regex(/^[^:]+(?::\d+)?$/, "path or path:line");

export const RepoExpectation = z.object({
  name: z.string(),
  description: z.string(),
  snapshot: z.object({ kind: z.enum(["zip", "git"]), hasHistory: z.boolean() }),
  languages: z.array(z.string()).min(1),
  frameworks: z.array(z.string()),
  packageManager: z.string(),
  routes: z.array(z.object({ method: z.string(), path: z.string(), locator: Locator })),
  envVars: z.object({
    read: z.array(z.object({ name: z.string(), locator: Locator })),
    documented: z.array(z.string()),
  }),
  /**
   * Probe outcomes. `skipped` and `tests: null` are for ecosystems whose dependency
   * download would run code, so nothing runs in the sandbox (Gradle; ADR 0026, ADR 0027).
   */
  probes: z.object({
    install: z.enum(["pass", "fail", "not_applicable", "skipped"]),
    build: z.enum(["pass", "fail", "not_applicable", "skipped"]),
    tests: z
      .object({ pass: z.number().int(), fail: z.number().int(), skip: z.number().int() })
      .nullable(),
  }),
  features: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["complete", "partial", "planned"]),
      implementation: z.array(Locator).optional(),
      tests: z.array(Locator).optional(),
      intent: z.array(Locator).optional(),
      why: z.string().optional(),
    }),
  ),
  findings: z.array(
    z
      .object({
        code: z.string(),
        locator: Locator,
        lineContains: z.string().optional(),
      })
      .loose(),
  ),
  absentFindings: z.array(z.string()),
  forbiddenClaims: z.array(z.object({ text: z.string(), reason: z.string() })).min(1),
});
export type RepoExpectation = z.infer<typeof RepoExpectation>;

export interface FixtureRepo {
  expected: RepoExpectation;
  /** The scan input. `expected.json` lives outside it so it never pollutes a scan. */
  repoDir: string;
}

export const FIXTURE_REPOS_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../repos",
);

export function loadFixtureRepos(dir: string = FIXTURE_REPOS_DIR): FixtureRepo[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "expected.json")))
    .map((d) => {
      const raw = JSON.parse(readFileSync(join(dir, d.name, "expected.json"), "utf8")) as unknown;
      const parsed = RepoExpectation.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid expected.json in ${d.name}: ${z.prettifyError(parsed.error)}`);
      }
      return { expected: parsed.data, repoDir: join(dir, d.name, "repo") };
    })
    .sort((a, b) => a.expected.name.localeCompare(b.expected.name));
}

/** Returns the text at `path:line` inside the repo, or null if the locator does not resolve. */
export function readLocator(repoDir: string, locator: string): string | null {
  const m = /^([^:]+)(?::(\d+))?$/.exec(locator);
  if (!m?.[1]) return null;
  const file = join(repoDir, m[1]);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (!m[2]) return text;
  return text.split("\n")[Number(m[2]) - 1] ?? null;
}
