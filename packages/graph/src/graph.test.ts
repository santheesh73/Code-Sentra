import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FileFacts, parseFile } from "@codesentra/parsers";
import { describe, expect, it } from "vitest";
import {
  aliasesFromTsconfig,
  analyzeHistory,
  buildGraph,
  type Commit,
  fanIn,
  hotspots,
  javaRootsOf,
  nextRouteOf,
  parseGitLog,
  resolveGoImport,
  resolveJavaImport,
  resolveJsImport,
  resolvePyImport,
  resolveRubyRequire,
} from "./index.js";

const REPOS = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/repos");

function listFiles(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory()
      ? listFiles(root, p)
      : [relative(root, p).split("\\").join("/")];
  });
}

async function graphOf(repo: string) {
  const root = join(REPOS, repo, "repo");
  const allPaths = listFiles(root).sort();
  const files: FileFacts[] = [];
  for (const p of allPaths) {
    const f = await parseFile(p, readFileSync(join(root, p), "utf8"));
    if (f) files.push(f);
  }
  return buildGraph({ files, allPaths });
}

describe("import resolution", () => {
  const files = new Set([
    "src/a.ts",
    "src/lib/b.tsx",
    "src/lib/index.ts",
    "src/util.js",
    "pkg/__init__.py",
    "pkg/store.py",
    "pkg/sub/x.py",
    "src/app/mod.py",
  ]);
  it("resolves relative, emitted-extension and index imports", () => {
    expect(resolveJsImport("src/a.ts", "./lib/b", files)).toBe("src/lib/b.tsx");
    expect(resolveJsImport("src/a.ts", "./lib/b.js", files)).toBe("src/lib/b.tsx");
    expect(resolveJsImport("src/a.ts", "./lib", files)).toBe("src/lib/index.ts");
    expect(resolveJsImport("src/lib/b.tsx", "../util.js", files)).toBe("src/util.js");
    expect(resolveJsImport("src/a.ts", "express", files)).toBeNull();
    expect(resolveJsImport("src/a.ts", "../../../etc/passwd", files)).toBeNull();
  });
  it("resolves tsconfig path aliases", () => {
    const aliases = aliasesFromTsconfig("tsconfig.json", {
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "#lib": ["src/lib/index.ts"] } },
    });
    expect(resolveJsImport("src/a.ts", "@/lib/b", files, aliases)).toBe("src/lib/b.tsx");
    expect(resolveJsImport("src/a.ts", "#lib", files, aliases)).toBe("src/lib/index.ts");
  });
  it("resolves Python absolute, package and relative imports", () => {
    expect(resolvePyImport("main.py", "pkg.store", files)).toBe("pkg/store.py");
    expect(resolvePyImport("main.py", "pkg", files)).toBe("pkg/__init__.py");
    expect(resolvePyImport("pkg/sub/x.py", "..store", files)).toBe("pkg/store.py");
    expect(resolvePyImport("pkg/store.py", ".", files)).toBe("pkg/__init__.py");
    expect(resolvePyImport("x.py", "app.mod", files)).toBe("src/app/mod.py");
    expect(resolvePyImport("x.py", "fastapi", files)).toBeNull();
  });
});

describe("Next.js file routes", () => {
  it("maps app/ and pages/ conventions", () => {
    expect(nextRouteOf("app/page.tsx")).toEqual({ path: "/", kind: "route" });
    expect(nextRouteOf("src/app/(shop)/pricing/page.tsx")).toEqual({
      path: "/pricing",
      kind: "route",
    });
    expect(nextRouteOf("app/api/ping/route.ts")).toEqual({
      path: "/api/ping",
      kind: "api_handler",
    });
    expect(nextRouteOf("app/layout.tsx")).toBeNull();
    expect(nextRouteOf("pages/index.tsx")).toEqual({ path: "/", kind: "route" });
    expect(nextRouteOf("pages/blog/[slug].tsx")).toEqual({ path: "/blog/[slug]", kind: "route" });
    expect(nextRouteOf("pages/api/users.ts")).toEqual({ path: "/api/users", kind: "api_handler" });
    expect(nextRouteOf("pages/_app.tsx")).toBeNull();
    expect(nextRouteOf("src/routes/tasks.ts")).toBeNull();
  });
});

describe("fixture repo graphs", () => {
  it("ts-taskboard: imports, routes, env vars and test edges", async () => {
    const g = await graphOf("ts-taskboard");
    const edges = (kind: string) =>
      g.edges.filter((e) => e.kind === kind).map((e) => `${e.from} -> ${e.to}`);
    expect(edges("imports")).toEqual([
      "file:src/lib/csv.ts -> file:src/lib/store.ts",
      "file:src/routes/tasks.ts -> file:src/lib/csv.ts",
      "file:src/routes/tasks.ts -> file:src/lib/store.ts",
      "file:src/server.ts -> file:src/routes/tasks.ts",
      "file:test/store.test.ts -> file:src/lib/csv.ts",
      "file:test/store.test.ts -> file:src/lib/store.ts",
    ]);
    expect(edges("tests")).toEqual([
      "file:test/store.test.ts -> file:src/lib/csv.ts",
      "file:test/store.test.ts -> file:src/lib/store.ts",
    ]);
    expect(edges("reads_env")).toEqual([
      "file:src/server.ts -> env:PORT",
      "file:src/server.ts -> env:TASKBOARD_ADMIN_TOKEN",
    ]);
    const routes = [...g.nodes.values()]
      .filter((n) => n.kind === "api_handler")
      .map((n) => `${n.name} ${n.path}:${n.line}`);
    expect(routes).toEqual([
      "POST /tasks src/routes/tasks.ts:8",
      "GET /tasks src/routes/tasks.ts:17",
      "PATCH /tasks/:id/done src/routes/tasks.ts:21",
      "GET /tasks/export.csv src/routes/tasks.ts:30",
    ]);
    expect(g.unresolved).toEqual([]);
    expect(fanIn(g).get("src/lib/store.ts")).toBe(3);
  });

  it("py-notes-api: package imports resolve", async () => {
    const g = await graphOf("py-notes-api");
    const imports = g.edges.filter((e) => e.kind === "imports").map((e) => `${e.from} -> ${e.to}`);
    expect(imports).toContain("file:notes_api/app.py -> file:notes_api/store.py");
    expect(imports).toContain("file:notes_api/app.py -> file:notes_api/config.py");
    expect(imports).toContain("file:tests/test_notes.py -> file:notes_api/app.py");
    expect(g.edges.filter((e) => e.kind === "tests").map((e) => e.to)).toEqual([
      "file:notes_api/app.py",
    ]);
  });

  it("is deterministic", async () => {
    const a = await graphOf("ts-taskboard");
    const b = await graphOf("ts-taskboard");
    expect(JSON.stringify([...a.nodes.values()])).toBe(JSON.stringify([...b.nodes.values()]));
    expect(a.edges).toEqual(b.edges);
  });
});

describe("history", () => {
  const c = (sha: string, author: string, date: string, files: string[]): Commit => ({
    sha,
    author,
    date,
    files,
  });
  const commits = [
    c("a1", "ana@x", "2026-01-01T00:00:00Z", ["src/core.ts", "src/api.ts"]),
    c("a2", "bo@x", "2026-01-02T00:00:00Z", ["src/core.ts", "src/api.ts", "README.md"]),
    c("a3", "ANA@x", "2026-01-03T00:00:00Z", ["src/core.ts"]),
    c(
      "a4",
      "cy@x",
      "2026-01-04T00:00:00Z",
      Array.from({ length: 51 }, (_, i) => `gen/f${i}.ts`),
    ),
  ];
  it("counts activity, contributors and co-changes", () => {
    const h = analyzeHistory(commits);
    expect(h.commits).toBe(4);
    expect(h.contributors).toBe(3);
    expect(h.churn.get("src/core.ts")).toBe(3);
    expect(h.lastTouched.get("src/core.ts")).toBe("2026-01-03T00:00:00Z");
    // Only src/core.ts + src/api.ts co-change twice; the 51-file commit is ignored.
    expect(h.coChanges).toEqual([{ a: "src/api.ts", b: "src/core.ts", count: 2 }]);
    expect(h.directories.map((d) => `${d.dir}:${d.commits}`)).toEqual(["src:3", ".:1", "gen:1"]);
  });
  it("finds hotspots only in the top decile of both churn and fan-in", () => {
    const churn = new Map(Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, i + 1] as const));
    const fan = new Map(
      Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, i % 2 ? 20 : 1] as const),
    );
    // Churn cut is the 18th of 20 values (f17); only odd files have high fan-in.
    expect(hotspots(churn, fan).map((h) => h.path)).toEqual(["f19.ts", "f17.ts"]);
    expect(hotspots(new Map([["a", 3]]), new Map())).toEqual([]);
  });
  it("parses git log output and drops paths escaping the repo", () => {
    const out =
      "\x1eabc1234\x1fana@x\x1f2026-01-01T00:00:00Z\n\nsrc/a.ts\n../evil\n/etc/passwd\n\x1edef5678\x1fbo@x\x1f2026-01-02T00:00:00Z\n\nb.py\n";
    expect(parseGitLog(out)).toEqual([
      { sha: "abc1234", author: "ana@x", date: "2026-01-01T00:00:00Z", files: ["src/a.ts"] },
      { sha: "def5678", author: "bo@x", date: "2026-01-02T00:00:00Z", files: ["b.py"] },
    ]);
  });
});

describe("Go, Ruby and Java resolution", () => {
  const files = new Set([
    "go.mod",
    "cmd/shop/main.go",
    "internal/cart/cart.go",
    "internal/cart/total.go",
    "internal/cart/cart_test.go",
    "tools/go.mod",
    "tools/gen/gen.go",
    "app.rb",
    "lib/store.rb",
    "lib/notes/export.rb",
    "src/main/java/com/x/shop/Item.java",
    "src/main/java/com/x/shop/model/Cart.java",
    "src/main/java/com/x/shop/model/Line.java",
    "src/test/java/com/x/shop/ItemTest.java",
  ]);
  const modules = [
    { dir: "", module: "example.com/shop" },
    { dir: "tools", module: "example.com/shop/tools" },
  ];

  it("resolves a Go import to the package's non-test files, by the longest module", () => {
    expect(resolveGoImport("example.com/shop/internal/cart", files, modules)).toEqual([
      "internal/cart/cart.go",
      "internal/cart/total.go",
    ]);
    expect(resolveGoImport("example.com/shop/tools/gen", files, modules)).toEqual([
      "tools/gen/gen.go",
    ]);
    expect(resolveGoImport("net/http", files, modules)).toEqual([]);
    expect(resolveGoImport("github.com/gin-gonic/gin", files, modules)).toEqual([]);
  });

  it("resolves require_relative against the file and require against lib/", () => {
    expect(resolveRubyRequire("app.rb", "lib/store", true, files)).toBe("lib/store.rb");
    expect(resolveRubyRequire("lib/store.rb", "notes/export", false, files)).toBe(
      "lib/notes/export.rb",
    );
    expect(resolveRubyRequire("app.rb", "json", false, files)).toBeNull();
  });

  it("resolves Java types and wildcard packages under the source roots", () => {
    const roots = javaRootsOf(files);
    expect(roots).toEqual(["src/main/java", "src/test/java"]);
    expect(resolveJavaImport("com.x.shop.Item", false, files, roots)).toEqual([
      "src/main/java/com/x/shop/Item.java",
    ]);
    expect(resolveJavaImport("com.x.shop.model", true, files, roots)).toEqual([
      "src/main/java/com/x/shop/model/Cart.java",
      "src/main/java/com/x/shop/model/Line.java",
    ]);
    expect(resolveJavaImport("java.util.List", false, files, roots)).toEqual([]);
  });

  it("draws import edges for Go packages in the graph", async () => {
    const main = await parseFile(
      "cmd/shop/main.go",
      'package main\nimport "example.com/shop/internal/cart"\nfunc main() { cart.New() }\n',
    );
    const g = buildGraph({
      files: [main as FileFacts],
      allPaths: [...files],
      goModules: modules,
    });
    expect(g.edges.filter((e) => e.kind === "imports").map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "file:cmd/shop/main.go -> file:internal/cart/cart.go",
      "file:cmd/shop/main.go -> file:internal/cart/total.go",
    ]);
  });

  it("a Go or Java test file tests its own package without importing it", async () => {
    const goTest = await parseFile(
      "internal/cart/cart_test.go",
      'package cart\nimport "testing"\nfunc TestTotal(t *testing.T) {}\n',
    );
    const javaTest = await parseFile(
      "src/test/java/com/x/shop/ItemTest.java",
      "package com.x.shop;\nclass ItemTest { @Test void ok() {} }\n",
    );
    const g = buildGraph({
      files: [goTest as FileFacts, javaTest as FileFacts],
      allPaths: [...files],
      goModules: modules,
    });
    expect(g.edges.filter((e) => e.kind === "tests").map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "file:internal/cart/cart_test.go -> file:internal/cart/cart.go",
      "file:internal/cart/cart_test.go -> file:internal/cart/total.go",
      "file:src/test/java/com/x/shop/ItemTest.java -> file:src/main/java/com/x/shop/Item.java",
    ]);
  });
});
