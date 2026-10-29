import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { draftIssues, launchPulseBrowser, runPulse } from "@codesentra/checks";
import { type Harness, loadFixtureApps, startHarness } from "@codesentra/fixture-harness";
import { buildGraph } from "@codesentra/graph";
import { parseFile } from "@codesentra/parsers";
import { testPolicy } from "@codesentra/ssrf";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blastRadius } from "./blast.js";
import {
  hostPortOf,
  type LinkGraph,
  normalizeMessage,
  routeMatches,
  templateSuffix,
  traceFinding,
  undefinedSuffix,
} from "./trace.js";

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the inputs are template literal sources
describe("join keys", () => {
  it("takes the static suffix after an undefined value", () => {
    expect(undefinedSuffix("https://a.dev/undefined/api/ping?x=1")).toBe("/api/ping");
    expect(undefinedSuffix("https://a.dev/null/v1")).toBe("/v1");
    expect(undefinedSuffix("https://a.dev/api/ping")).toBeNull();
    expect(undefinedSuffix("https://a.dev/undefined")).toBeNull();
  });

  it("takes a template's static suffix", () => {
    expect(templateSuffix("${process.env.API}/api/ping")).toBe("/api/ping");
    expect(templateSuffix("${a}/x/${b}/y?z=1")).toBe("/y");
    expect(templateSuffix("/plain")).toBe("/plain");
  });

  it("takes host and port as the browser saw them", () => {
    expect(hostPortOf("http://localhost:4000/data")).toBe("localhost:4000");
    expect(hostPortOf("http://127.0.0.1/x")).toBe("127.0.0.1");
  });

  it("strips runtime prefixes from messages, nothing else", () => {
    expect(normalizeMessage("Uncaught Error: CS_FIXTURE_BOOM")).toBe("CS_FIXTURE_BOOM");
    expect(normalizeMessage("TypeError:  cannot   read x")).toBe("cannot read x");
    expect(normalizeMessage("Uncaught (in promise) boom")).toBe("boom");
    expect(normalizeMessage("CS_FIXTURE_BOOM")).toBe("CS_FIXTURE_BOOM");
  });

  it("matches route patterns segment by segment", () => {
    expect(routeMatches("/tasks/[id]", "/tasks/42")).toBe(true);
    expect(routeMatches("/tasks/:id", "/tasks/42")).toBe(true);
    expect(routeMatches("/tasks/{id}", "/tasks/42/x")).toBe(false);
    expect(routeMatches("/tasks/<id>", "/tasks/42")).toBe(true);
    expect(routeMatches("/docs/[...slug]", "/docs/a/b")).toBe(true);
    expect(routeMatches("/", "/")).toBe(true);
    expect(routeMatches("/about", "/pricing")).toBe(false);
  });
});

const node = (
  id: string,
  kind: string,
  path: string | null,
  line: number | null,
  meta: Record<string, unknown> = {},
) => ({ id, kind, path, name: id, line, meta });

describe("trace rules (exact joins only)", () => {
  const graph: LinkGraph = {
    nodes: [
      node("f1", "file", "src/api.ts", null),
      node("s1", "symbol", "src/api.ts", 3, {}),
      node("l1", "literal", "src/api.ts", 5, {
        role: "url_template",
        value: "${BASE}/api/pingx",
        text: "fetch(`${BASE}/api/pingx`)",
        envVars: "BASE",
      }),
      node("r1", "api_handler", "src/server.ts", 8, { routePath: "/tasks/:id" }),
    ],
    edges: [],
    documentedEnv: new Set(["BASE"]),
  };

  it("does not match a suffix that only starts the same", () => {
    const t = traceFinding(
      { code: "UNDEFINED_IN_URL", locator: "https://a.dev/undefined/api/ping", message: "" },
      graph,
    );
    expect(t.verified).toBe(false);
    expect(t.reason).toContain("/api/ping");
  });

  it("traces a broken route to its handler, a missing one stays unverified and is reclassified", () => {
    const hit = traceFinding(
      { code: "ROUTE_BROKEN", locator: "https://a.dev/tasks/7", message: "" },
      graph,
    );
    expect(hit).toMatchObject({ verified: true, reclassifiedAs: null, joinKey: "/tasks/7" });
    expect(hit.sites[0]).toMatchObject({ path: "src/server.ts", line: 8 });
    const miss = traceFinding(
      { code: "ROUTE_BROKEN", locator: "https://a.dev/nope", message: "" },
      graph,
    );
    expect(miss).toMatchObject({ verified: false, reclassifiedAs: "ROUTE_MISSING" });
  });

  it("traces Scan findings directly to their file and line", () => {
    const t = traceFinding({ code: "TODO_MARKER", locator: "src/api.ts:5", message: "" }, graph);
    expect(t).toMatchObject({ verified: true, joinKey: "src/api.ts:5" });
    expect(t.sites[0]).toMatchObject({ path: "src/api.ts", line: 5, symbol: "s1" });
    expect(t.envVars).toEqual([{ name: "BASE", documented: true }]);
    expect(
      traceFinding({ code: "TODO_MARKER", locator: "gone.ts:1", message: "" }, graph).verified,
    ).toBe(false);
  });
});

// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above

describe("blast radius", () => {
  const g: LinkGraph = {
    nodes: ["a", "b", "c", "d", "e"].map((p) => node(p, "file", `${p}.ts`, null)),
    edges: [
      { fromId: "b", toId: "a", kind: "imports", weight: 1 },
      { fromId: "c", toId: "b", kind: "imports", weight: 1 },
      { fromId: "d", toId: "c", kind: "imports", weight: 1 },
      { fromId: "a", toId: "e", kind: "co_changes", weight: 4 },
    ],
    documentedEnv: new Set(),
  };

  it("follows importers 2 hops and co-change partners, with reasons", () => {
    expect(blastRadius(["a.ts"], g)).toEqual([
      { path: "b.ts", reason: "imports a.ts", hops: 1 },
      { path: "e.ts", reason: "changed together with a.ts in 4 commits", hops: 1 },
      { path: "c.ts", reason: "imports b.ts, which imports a.ts", hops: 2 },
    ]);
  });

  it("never lists a traced file", () => {
    expect(blastRadius(["a.ts", "b.ts"], g).map((e) => e.path)).toEqual(["c.ts", "e.ts", "d.ts"]);
  });
});

/** The fixture app's source as Scan would graph it (everything but build output). */
async function graphOf(dir: string): Promise<LinkGraph> {
  const paths: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (["node_modules", ".next", ".turbo", "out", "out-fixed"].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else paths.push(relative(dir, p));
    }
  };
  walk(dir);
  const files = [];
  for (const p of paths) {
    const f = await parseFile(p, readFileSync(join(dir, p), "utf8"));
    if (f) files.push(f);
  }
  const g = buildGraph({ files, allPaths: paths });
  return {
    nodes: [...g.nodes.values()].map((n) => ({ ...n, id: n.key })),
    edges: g.edges.map((e) => ({ fromId: e.from, toId: e.to, kind: e.kind, weight: e.weight })),
    documentedEnv: new Set(),
  };
}

describe("Go, Ruby, Java, Rust and PHP routes are trace targets (ADR 0026, ADR 0028)", () => {
  const repos = join(new URL(".", import.meta.url).pathname, "../../../fixtures/repos");
  it.each([
    ["go-shop-api", "https://shop.example/products/p9", "cmd/shop/main.go", 17],
    ["rb-notes-api", "https://notes.example/notes/5/export.md", "app.rb", 28],
    [
      "java-shop-api",
      "https://shop.example/api/orders/export.csv",
      "src/main/java/com/example/shop/OrderController.java",
      27,
    ],
    ["rs-notes-api", "https://notes.example/notes/5/export.md", "src/lib.rs", 17],
    ["php-notes-api", "https://notes.example/notes/5/export.md", "public/index.php", 37],
  ] as const)("%s: a broken %s traces to %s:%i", async (repo, url, path, line) => {
    const t = traceFinding(
      { code: "ROUTE_BROKEN", locator: url, message: "" },
      await graphOf(join(repos, repo, "repo")),
    );
    expect(t.verified, t.reason ?? undefined).toBe(true);
    expect(t.sites[0]).toMatchObject({ path, line });
  });
});

let h: Harness;
let browser: Browser;
beforeAll(async () => {
  h = await startHarness();
  const launched = await launchPulseBrowser();
  if (!launched.browser) throw new Error(launched.reason); // no silent skip (Rule 2)
  browser = launched.browser;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await h?.close();
});

describe("every fixture app's issue traces to its documented file and line (Phase 4)", () => {
  for (const app of loadFixtureApps()) {
    for (const [variant, expected] of Object.entries(app.manifest.expected)) {
      for (const want of expected.issues.filter((i) => i.trace)) {
        it(`${app.manifest.name} (${variant}): ${want.leadCode} → ${want.trace?.file}:${want.trace?.line}`, async () => {
          h.setVariant(app.manifest.name, variant);
          try {
            const target = h.targets.apps[app.manifest.name];
            if (!target) throw new Error("not served");
            const r = await runPulse({
              url: target.url,
              policy: testPolicy(["127.0.0.1", "localhost"], { ca: h.caCertPem }),
              browser,
              timeoutMs: 3000,
            });
            const issues = draftIssues(r.findings, r.evidence, {
              target: { url: target.url, environment: null },
              project: null,
              platform: r.platform,
              lastSuccessfulCheck: null,
              scanSummary: null,
            });
            const graph = await graphOf(app.dir);
            const traced = issues.map((i) => ({
              issue: i,
              trace: traceFinding(
                {
                  code: i.code,
                  locator: i.locator,
                  discriminator: r.findings[i.findingIndexes[0] as number]?.discriminator ?? null,
                  message: i.summary,
                },
                graph,
              ),
            }));
            const lead = (t: (typeof traced)[number]) => t.trace.reclassifiedAs ?? t.issue.code;
            const hit = traced.find((t) => lead(t) === want.leadCode);
            expect(hit, `issues: ${traced.map(lead).join(", ")}`).toBeTruthy();
            if (want.reclassifiedFrom) expect(hit?.issue.code).toBe(want.reclassifiedFrom);
            for (const c of want.corroboratedBy ?? [])
              expect(hit?.issue.corroboratingCodes).toContain(c);
            const t = hit?.trace;
            expect(t?.verified, t?.reason ?? "").toBe(true);
            expect(t?.joinKey).toBe(want.trace?.joinKey);
            expect(t?.sites[0]).toMatchObject({ path: want.trace?.file, line: want.trace?.line });
            expect(t?.sites[0]?.excerpt).toContain(want.trace?.lineContains);
            expect(t?.envVars.map((e) => e.name)).toEqual(want.trace?.envVars ?? []);
          } finally {
            h.setVariant(app.manifest.name, app.manifest.defaultVariant);
          }
        });
      }
    }
  }
});
