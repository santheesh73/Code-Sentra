import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SelfTestVariant = z.object({
  /** Requests the page must make. `path` matches same-origin requests; `url` matches absolute URLs. */
  requests: z
    .array(
      z.union([
        z.object({ path: z.string().startsWith("/"), status: z.number().int().optional() }),
        z.object({ url: z.url(), status: z.number().int().optional() }),
      ]),
    )
    .default([]),
  forbiddenRequestPaths: z.array(z.string()).default([]),
  /** Same-origin links on the page and the status each must return. */
  links: z.array(z.object({ path: z.string(), status: z.number().int() })).default([]),
  /** Substrings each uncaught page error must contain; empty means none allowed. */
  pageErrors: z.array(z.string()).default([]),
  consoleErrors: z.array(z.string()).optional(),
  noFailedRequests: z.boolean().default(false),
  minTextLength: z.number().int().optional(),
  maxTextLength: z.number().int().optional(),
});
export type SelfTestVariant = z.infer<typeof SelfTestVariant>;

const ExpectedVariant = z.object({
  pulseStatus: z.enum(["live", "degraded", "down", "unverified"]),
  findings: z.array(
    z.object({
      code: z.string(),
      path: z.string().optional(),
      url: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
  issues: z.array(
    z.object({
      leadCode: z.string(),
      corroboratedBy: z.array(z.string()).optional(),
      reclassifiedFrom: z.string().optional(),
      promptType: z.enum(["code_fix", "config_fix", "outage_triage", "investigate"]),
      promptMustMention: z.array(z.string()).default([]),
      configGuidanceMustMention: z.array(z.string()).optional(),
      trace: z
        .object({
          file: z.string(),
          line: z.number().int().positive(),
          lineContains: z.string(),
          joinKey: z.string(),
          envVars: z.array(z.string()).optional(),
        })
        .optional(),
    }),
  ),
});

export const FixtureManifest = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1),
    variants: z.record(
      z.string(),
      z.object({ outDir: z.string(), env: z.record(z.string(), z.string()) }),
    ),
    defaultVariant: z.string(),
    backendRoutes: z.record(
      z.string().startsWith("/"),
      z.object({ status: z.number().int(), json: z.unknown() }),
    ),
    selfTest: z.record(z.string(), SelfTestVariant),
    expected: z.record(z.string(), ExpectedVariant),
  })
  .superRefine((m, ctx) => {
    if (!m.variants[m.defaultVariant]) {
      ctx.addIssue({ code: "custom", message: `defaultVariant ${m.defaultVariant} not declared` });
    }
    for (const v of Object.keys(m.variants)) {
      if (!m.selfTest[v]) ctx.addIssue({ code: "custom", message: `selfTest missing for ${v}` });
      if (!m.expected[v]) ctx.addIssue({ code: "custom", message: `expected missing for ${v}` });
    }
  });
export type FixtureManifest = z.infer<typeof FixtureManifest>;

export interface FixtureApp {
  manifest: FixtureManifest;
  dir: string;
}

export const FIXTURE_APPS_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../apps");

export function loadFixtureApps(dir: string = FIXTURE_APPS_DIR): FixtureApp[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "fixture.json")))
    .map((d) => {
      const appDir = join(dir, d.name);
      const raw = JSON.parse(readFileSync(join(appDir, "fixture.json"), "utf8")) as unknown;
      const parsed = FixtureManifest.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid fixture.json in ${d.name}: ${z.prettifyError(parsed.error)}`);
      }
      if (parsed.data.name !== d.name) {
        throw new Error(`fixture.json name ${parsed.data.name} does not match directory ${d.name}`);
      }
      return { manifest: parsed.data, dir: appDir };
    })
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}
