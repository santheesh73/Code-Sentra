import { type FileFacts, isTestPath } from "@codesentra/parsers";
import {
  type GoModule,
  javaRootsOf,
  type PathAliases,
  type PhpAutoload,
  type RustCrate,
  resolveGoImport,
  resolveJavaImport,
  resolveJsImport,
  resolvePhpRequire,
  resolvePhpUse,
  resolvePyImport,
  resolveRubyRequire,
  resolveRustMod,
  resolveRustUse,
} from "./resolve.js";

export type NodeKind =
  | "file"
  | "symbol"
  | "route"
  | "api_handler"
  | "cli_command"
  | "env_var"
  | "test"
  | "literal";
export type EdgeKind = "imports" | "calls" | "defines_route" | "reads_env" | "tests" | "co_changes";

export interface GraphNode {
  /** Stable key within one snapshot, e.g. `file:src/a.ts`, `env:PORT`. */
  key: string;
  kind: NodeKind;
  path: string | null;
  name: string;
  line: number | null;
  /** Kind-specific details (HTTP method, test status, …). */
  meta: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
}

export interface CodeGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** Imports that pointed into the repo but did not resolve (`./missing`). */
  unresolved: { from: string; specifier: string; line: number }[];
}

export interface GraphInput {
  files: FileFacts[];
  /** Every repo file path (parsed or not), repo-relative with `/`. */
  allPaths: string[];
  aliases?: PathAliases;
  pythonRoots?: string[];
  /** go.mod modules (directory and module path), for Go import resolution. */
  goModules?: GoModule[];
  /** Cargo packages (directory and crate name), for Rust `use` resolution. */
  rustCrates?: RustCrate[];
  /** composer.json PSR-4 maps, for PHP `use` resolution. */
  phpAutoload?: PhpAutoload[];
}

const NEXT_PAGE =
  /^(?:src\/)?(app|pages)\/(.*?)(?:\/)?(page|route|index|[^/]+)\.(tsx|ts|jsx|js|mdx)$/;

/** Route path for a Next.js `app/` or `pages/` file, or null when it is not a route file. */
export function nextRouteOf(path: string): { path: string; kind: "route" | "api_handler" } | null {
  const m = NEXT_PAGE.exec(path);
  if (!m) return null;
  const [, dir, rest = "", leaf] = m;
  const segs = (rest ? rest.split("/") : []).filter(
    (s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"),
  );
  if (dir === "app") {
    if (leaf !== "page" && leaf !== "route") return null;
    if (segs.some((s) => s.startsWith("_"))) return null;
    return {
      path: `/${segs.join("/")}`.replace(/\/$/, "") || "/",
      kind: leaf === "route" ? "api_handler" : "route",
    };
  }
  // pages/: every file is a route except _app/_document/_error and files under pages/api are handlers.
  if (leaf?.startsWith("_")) return null;
  const all = [...segs, ...(leaf === "index" ? [] : [leaf as string])];
  const routePath = `/${all.join("/")}`.replace(/\/$/, "") || "/";
  return { path: routePath, kind: all[0] === "api" ? "api_handler" : "route" };
}

/** Builds the snapshot's code graph from parsed facts. Pure and deterministic. */
export function buildGraph(input: GraphInput): CodeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const unresolved: CodeGraph["unresolved"] = [];
  const paths = new Set(input.allPaths);
  const add = (n: GraphNode) => {
    if (!nodes.has(n.key)) nodes.set(n.key, n);
    return n.key;
  };
  const fileKey = (p: string) =>
    add({ key: `file:${p}`, kind: "file", path: p, name: p, line: null, meta: {} });

  for (const p of [...input.allPaths].sort()) fileKey(p);

  const javaRoots = javaRootsOf(input.allPaths);
  const resolveImport = (f: FileFacts, imp: FileFacts["imports"][number]): string[] => {
    const one = (t: string | null) => (t ? [t] : []);
    switch (imp.kind) {
      case "go":
        return resolveGoImport(imp.specifier, paths, input.goModules ?? []);
      case "ruby":
      case "ruby-relative":
        return one(resolveRubyRequire(f.path, imp.specifier, imp.kind === "ruby-relative", paths));
      case "java":
      case "java-wildcard":
        return resolveJavaImport(imp.specifier, imp.kind === "java-wildcard", paths, javaRoots);
      case "rust":
        return one(resolveRustUse(f.path, imp.specifier, paths, input.rustCrates ?? []));
      case "rust-mod":
        return one(resolveRustMod(f.path, imp.specifier, paths));
      case "php":
        return one(resolvePhpUse(imp.specifier, paths, input.phpAutoload ?? []));
      case "php-require":
        return one(resolvePhpRequire(f.path, imp.specifier, paths));
      case "python":
      case "python-member":
        return one(resolvePyImport(f.path, imp.specifier, paths, input.pythonRoots));
      default:
        return f.language === "python"
          ? one(resolvePyImport(f.path, imp.specifier, paths, input.pythonRoots))
          : one(resolveJsImport(f.path, imp.specifier, paths, input.aliases));
    }
  };

  for (const f of input.files) {
    const from = fileKey(f.path);
    for (const imp of f.imports) {
      const targets = resolveImport(f, imp);
      for (const target of targets)
        if (target !== f.path)
          edges.push({ from, to: fileKey(target), kind: "imports", weight: 1 });
      if (
        !targets.length &&
        ((imp.kind !== "python-member" &&
          imp.kind !== "php-require" &&
          imp.specifier.startsWith(".")) ||
          imp.kind === "ruby-relative" ||
          imp.kind === "rust-mod" ||
          // Composer's vendor/ is installed, not committed.
          (imp.kind === "php-require" && !/(^|\/)vendor\//.test(imp.specifier)))
      ) {
        unresolved.push({ from: f.path, specifier: imp.specifier, line: imp.line });
      }
    }
    for (const s of f.symbols) {
      const key = add({
        key: `symbol:${f.path}#${s.name}`,
        kind: "symbol",
        path: f.path,
        name: s.name,
        line: s.line,
        meta: { symbolKind: s.kind, exported: s.exported },
      });
      edges.push({ from, to: key, kind: "calls", weight: 0 });
    }
    for (const r of f.routes) {
      const key = add({
        key: `api_handler:${r.method} ${r.path}@${f.path}:${r.line}`,
        kind: "api_handler",
        path: f.path,
        name: `${r.method} ${r.path}`,
        line: r.line,
        meta: { method: r.method, routePath: r.path, handler: r.handler },
      });
      edges.push({ from, to: key, kind: "defines_route", weight: 1 });
    }
    for (const e of f.envReads) {
      const key = add({
        key: `env:${e.name}`,
        kind: "env_var",
        path: null,
        name: e.name,
        line: null,
        meta: {},
      });
      edges.push({ from, to: key, kind: "reads_env", weight: 1 });
    }
    for (const c of f.cliCommands) {
      const key = add({
        key: `cli:${c.name}`,
        kind: "cli_command",
        path: f.path,
        name: c.name,
        line: c.line,
        meta: {},
      });
      edges.push({ from, to: key, kind: "defines_route", weight: 1 });
    }
    // Literals Sentra Link joins runtime evidence on (Section 10a).
    const literal = (role: string, value: string, line: number, text: string, extra = {}) =>
      add({
        key: `literal:${role}:${f.path}:${line}:${value.slice(0, 500)}`,
        kind: "literal",
        path: f.path,
        name: value.slice(0, 500),
        line,
        meta: { role, value: value.slice(0, 2000), text, ...extra },
      });
    for (const u of f.urlLiterals)
      literal(u.template ? "url_template" : "url", u.value, u.line, u.text, {
        envVars: u.envVars.join(","),
      });
    for (const h of f.hrefs) literal("href", h.value, h.line, h.text);
    for (const m of f.messages) literal(m.kind, m.value, m.line, m.text);
    for (const t of f.tests) {
      const key = add({
        key: `test:${f.path}:${t.line}`,
        kind: "test",
        path: f.path,
        name: t.name,
        line: t.line,
        meta: { skipped: t.skipped },
      });
      edges.push({ from, to: key, kind: "calls", weight: 0 });
    }
  }

  // Next.js file-system routes, at the page component when the file was parsed.
  const factsByPath = new Map(input.files.map((f) => [f.path, f]));
  for (const p of input.allPaths) {
    const r = nextRouteOf(p);
    if (!r) continue;
    const def = factsByPath.get(p)?.defaultExport ?? null;
    const key = add({
      key: `${r.kind}:${r.path}@${p}`,
      kind: r.kind,
      path: p,
      name: r.path,
      line: def?.line ?? 1,
      meta: {
        routePath: r.path,
        method: r.kind === "route" ? "GET" : null,
        symbol: def?.name ?? null,
        text: def?.text ?? null,
      },
    });
    edges.push({ from: fileKey(p), to: key, kind: "defines_route", weight: 1 });
  }

  // A Go or Java test file sees its own package without importing it (Go `_test.go`
  // files in the package's directory; Java tests in the same package under another
  // source root), so it tests those files too.
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const byDir = new Map<string, string[]>();
  for (const p of input.allPaths) {
    const list = byDir.get(dirOf(p));
    if (list) list.push(p);
    else byDir.set(dirOf(p), [p]);
  }
  for (const f of input.files) {
    if (!isTestPath(f.path)) continue;
    let siblings: string[] = [];
    if (f.language === "go") {
      siblings = (byDir.get(dirOf(f.path)) ?? []).filter(
        (p) => p.endsWith(".go") && !p.endsWith("_test.go"),
      );
    } else if (f.language === "java") {
      const root = javaRoots.find((r) => f.path.startsWith(`${r}/`));
      if (root) {
        const pkgDir = dirOf(f.path).slice(root.length);
        siblings = javaRoots
          .flatMap((r) => byDir.get(`${r}${pkgDir}`) ?? [])
          .filter((p) => p.endsWith(".java") && !isTestPath(p));
      }
    }
    for (const p of siblings)
      edges.push({ from: fileKey(f.path), to: fileKey(p), kind: "tests", weight: 1 });
  }

  // Test files test what they import.
  for (const e of edges.filter((x) => x.kind === "imports")) {
    const fromPath = nodes.get(e.from)?.path;
    const toPath = nodes.get(e.to)?.path;
    if (fromPath && toPath && isTestPath(fromPath) && !isTestPath(toPath))
      edges.push({ from: e.from, to: e.to, kind: "tests", weight: 1 });
  }

  edges.sort((a, b) => `${a.kind}|${a.from}|${a.to}`.localeCompare(`${b.kind}|${b.from}|${b.to}`));
  return { nodes, edges: dedupe(edges), unresolved };
}

function dedupe(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Map<string, GraphEdge>();
  for (const e of edges) {
    const k = `${e.kind}|${e.from}|${e.to}`;
    const prev = seen.get(k);
    if (prev) prev.weight = Math.max(prev.weight, e.weight);
    else seen.set(k, { ...e });
  }
  return [...seen.values()];
}

/** Inbound `imports` edges per file path (fan-in). */
export function fanIn(graph: CodeGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind !== "imports") continue;
    const p = graph.nodes.get(e.to)?.path;
    if (p) out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}
