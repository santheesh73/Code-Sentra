import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  aliasesFromTsconfig,
  buildGraph,
  type CodeGraph,
  type PathAliases,
} from "@codesentra/graph";
import {
  detectLanguage,
  type FileFacts,
  isTestPath,
  MAX_PARSE_BYTES,
  PARSED_LANGUAGES,
  parseFile,
} from "@codesentra/parsers";
import { isVendored, type TreeEntry } from "./ingest/tree.js";
import type { ScanRecorder } from "./recorder.js";

export interface MapResult {
  languages: Record<string, number>;
  unsupported: Record<string, number>;
  frameworks: string[];
  packageManager: string | null;
  facts: FileFacts[];
  graph: CodeGraph;
  /** All non-vendored paths. */
  paths: string[];
  /** Readable text by path (source and docs; capped files excluded). */
  text: Map<string, string>;
  envRead: Map<string, { file: string; line: number; key: string }[]>;
  envDocumented: Map<string, { file: string; line: number; key: string } | null>;
  /** Evidence key per test case `file:line`. */
  testEvidence: Map<string, string>;
  /** Evidence key per source file. */
  fileEvidence: Map<string, string>;
  hasReadme: boolean;
  hasSetupSteps: boolean;
  sourceLines: number;
  markers: number;
  gaps: string[];
}

const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /^next$/],
  ["React", /^react$/],
  ["Vue", /^vue$/],
  ["Svelte", /^svelte$/],
  ["Vite", /^vite$/],
  ["Express", /^express$/],
  ["Fastify", /^fastify$/],
  ["NestJS", /^@nestjs\/core$/],
  ["Koa", /^koa$/],
  ["Hono", /^hono$/],
  ["Django", /^django$/],
  ["Flask", /^flask$/],
  ["FastAPI", /^fastapi$/],
];

const ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  "example.env",
  ".env.defaults",
]);
const DOC_FILE = /^(readme|roadmap|changelog|contributing|features)(\.[a-z]+)?$/i;
const MAX_DOC_EXCERPTS = 400;

function isDocPath(p: string): boolean {
  const base = posix.basename(p);
  return (
    (!p.includes("/") && DOC_FILE.test(base)) ||
    /^docs?\/.*\.(md|mdx|rst|txt)$/i.test(p) ||
    /^\.github\/ISSUE_TEMPLATE\//.test(p)
  );
}

/** Map stage (Section 8.2): deterministic, never executes project code. */
export async function mapProject(
  root: string,
  tree: TreeEntry[],
  rec: ScanRecorder,
): Promise<MapResult> {
  const gaps: string[] = [];
  const paths = tree.map((t) => t.path).filter((p) => !isVendored(p));
  const text = new Map<string, string>();
  const languages: Record<string, number> = {};
  const unsupported: Record<string, number> = {};
  const facts: FileFacts[] = [];
  const tooBig: string[] = [];

  for (const t of tree) {
    if (isVendored(t.path)) continue;
    const lang = detectLanguage(t.path);
    const wanted =
      lang !== null ||
      isDocPath(t.path) ||
      ENV_EXAMPLES.has(posix.basename(t.path)) ||
      /\.(json|toml|txt|ya?ml|lock|cfg)$/.test(t.path);
    if (!wanted) continue;
    if (t.size > MAX_PARSE_BYTES) {
      tooBig.push(t.path);
      continue;
    }
    const buf = await readFile(join(root, t.path));
    if (buf.includes(0)) continue;
    const s = buf.toString("utf8");
    text.set(t.path, s);
    const detected = detectLanguage(t.path, s.slice(0, 200).split("\n")[0]);
    if (detected) {
      languages[detected] = (languages[detected] ?? 0) + 1;
      if (!PARSED_LANGUAGES.has(detected)) unsupported[detected] = (unsupported[detected] ?? 0) + 1;
    }
  }
  for (const [p, s] of text) {
    const f = await parseFile(p, s);
    if (f) facts.push(f);
  }
  facts.sort((a, b) => a.path.localeCompare(b.path));
  if (Object.keys(unsupported).length)
    gaps.push(
      `not parsed (no parser yet): ${Object.entries(unsupported)
        .map(([l, n]) => `${l} (${n} files)`)
        .join(", ")}`,
    );
  if (tooBig.length)
    gaps.push(`${tooBig.length} files over ${MAX_PARSE_BYTES / 1024 / 1024} MB were not parsed`);
  rec.addEvidence("language_coverage", ".", {
    languages,
    parsed: Object.keys(languages)
      .filter((l) => PARSED_LANGUAGES.has(l))
      .sort(),
    unsupported,
    files_total: paths.length,
    not_parsed_large_files: tooBig.slice(0, 50),
  });

  // --- Manifests -----------------------------------------------------------------
  const deps = new Set<string>();
  let packageManager: string | null = null;
  let aliases: PathAliases = [];
  const pkgText = text.get("package.json");
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as {
        name?: string;
        version?: string;
        description?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        bin?: string | Record<string, string>;
      };
      for (const d of [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ])
        deps.add(d);
      packageManager = paths.includes("pnpm-lock.yaml")
        ? "pnpm"
        : paths.includes("yarn.lock")
          ? "yarn"
          : "npm";
      rec.addEvidence("manifest", "package.json", {
        file: "package.json",
        name: pkg.name ?? null,
        version: pkg.version ?? null,
        description: pkg.description ?? null,
        package_manager: packageManager,
        scripts: pkg.scripts ?? {},
        dependencies: pkg.dependencies ?? {},
        dev_dependencies: pkg.devDependencies ?? {},
        bin: typeof pkg.bin === "string" ? { [pkg.name ?? "bin"]: pkg.bin } : (pkg.bin ?? {}),
      });
    } catch {
      gaps.push("package.json is not valid JSON");
    }
  }
  const tsconfig = text.get("tsconfig.json");
  if (tsconfig) {
    try {
      aliases = aliasesFromTsconfig(
        "tsconfig.json",
        JSON.parse(tsconfig.replace(/^\s*\/\/.*$/gm, "")),
      );
    } catch {
      gaps.push("tsconfig.json could not be read (path aliases not resolved)");
    }
  }
  const pyFiles = paths.filter((p) =>
    /^(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/.test(p),
  );
  if (pyFiles.length) {
    packageManager ??= "pip";
    const pyDeps: Record<string, string> = {};
    for (const f of pyFiles.filter((p) => p.endsWith(".txt"))) {
      for (const line of (text.get(f) ?? "").split("\n")) {
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|>=|~=|<=|>|<)?\s*([^\s;#]*)/.exec(
          line.trim(),
        );
        if (m && !line.trim().startsWith("-")) {
          const name = (m[1] as string).toLowerCase();
          pyDeps[name] = m[3] ? `${m[2]}${m[3]}` : "*";
          deps.add(name);
        }
      }
    }
    const pyproject = text.get("pyproject.toml") ?? "";
    for (const m of pyproject.matchAll(/^\s*"([A-Za-z0-9][A-Za-z0-9._-]*)/gm))
      deps.add((m[1] as string).toLowerCase());
    rec.addEvidence("manifest", pyFiles[0] as string, {
      files: pyFiles,
      name: /^name\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? null,
      description: /^description\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? null,
      version: /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? null,
      package_manager: "pip",
      dependencies: pyDeps,
    });
  }
  const frameworks = FRAMEWORKS.filter(([, re]) => [...deps].some((d) => re.test(d))).map(
    ([n]) => n,
  );
  if (frameworks.length || packageManager)
    rec.addEvidence("manifest", pkgText ? "package.json" : (pyFiles[0] ?? "."), {
      frameworks,
      package_manager: packageManager,
      languages: Object.keys(languages).sort(),
      dependency_names: [...deps].sort(),
    });

  // --- Docs (intent) ----------------------------------------------------------------
  let excerpts = 0;
  const docPaths = paths
    .filter(isDocPath)
    .sort((a, b) =>
      a.toLowerCase().startsWith("readme")
        ? -1
        : b.toLowerCase().startsWith("readme")
          ? 1
          : a.localeCompare(b),
    );
  const hasReadme = paths.some((p) => /^readme(\.[a-z]+)?$/i.test(p));
  let hasSetupSteps = false;
  for (const p of docPaths) {
    const lines = (text.get(p) ?? "").split("\n");
    let section = "";
    let inCode = false;
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("```")) {
        inCode = !inCode;
        if (inCode && /setup|install|getting started|quick ?start|usage|run/i.test(section))
          hasSetupSteps = true;
        return;
      }
      if (inCode || !line || excerpts >= MAX_DOC_EXCERPTS) return;
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      if (heading) section = heading[1] as string;
      const isItem =
        heading || /^([-*+]|\d+\.)\s+/.test(line) || (section === "" && i < 20) || i < 6;
      if (!isItem) return;
      excerpts++;
      rec.addEvidence("doc_excerpt", `${p}:${i + 1}`, {
        file: p,
        line: i + 1,
        section,
        text: line.slice(0, 500),
      });
    });
  }
  if (excerpts >= MAX_DOC_EXCERPTS)
    gaps.push(`docs: only the first ${MAX_DOC_EXCERPTS} lines were used`);

  // --- Code facts -------------------------------------------------------------------
  const allPaths = paths;
  const graph = buildGraph({ files: facts, allPaths, aliases });
  const fileEvidence = new Map<string, string>();
  const testEvidence = new Map<string, string>();
  const envRead = new Map<string, { file: string; line: number; key: string }[]>();
  let sourceLines = 0;
  let markers = 0;
  for (const f of facts) {
    const lines = (text.get(f.path) ?? "").split("\n").length;
    sourceLines += lines;
    const imports = graph.edges
      .filter((e) => e.kind === "imports" && e.from === `file:${f.path}`)
      .map((e) => e.to.slice(5));
    fileEvidence.set(
      f.path,
      rec.addEvidence("code_fact", f.path, {
        kind: "file",
        file: f.path,
        language: f.language,
        lines,
        test_file: isTestPath(f.path),
        symbols: f.symbols.slice(0, 100).map((s) => s.name),
        imports,
        packages: [
          ...new Set(f.imports.map((i) => i.specifier).filter((s) => !s.startsWith("."))),
        ].slice(0, 100),
        parse_errors: f.parseErrors,
      }),
    );
    for (const r of f.routes) {
      rec.addEvidence("route", `${f.path}:${r.line}`, {
        method: r.method,
        path: r.path,
        file: f.path,
        line: r.line,
        handler: r.handler,
        text: r.text,
      });
    }
    for (const e of f.envReads) {
      const key = rec.addEvidence("env_var_read", `${f.path}:${e.line}`, {
        name: e.name,
        file: f.path,
        line: e.line,
        text: e.text,
      });
      const list = envRead.get(e.name) ?? [];
      list.push({ file: f.path, line: e.line, key });
      envRead.set(e.name, list);
    }
    for (const m of f.markers) {
      markers++;
      const key = rec.addEvidence("marker", `${f.path}:${m.line}`, {
        kind: m.kind,
        file: f.path,
        line: m.line,
        text: m.text,
      });
      rec.addFinding(
        "TODO_MARKER",
        key,
        `${f.path}:${m.line}`,
        `${m.kind} in ${f.path}:${m.line}: ${m.text}`,
      );
    }
    for (const s of f.stubs) {
      markers++;
      const key = rec.addEvidence("code_fact", `${f.path}:${s.line}`, {
        kind: "stub",
        symbol: s.symbol,
        file: f.path,
        line: s.line,
        text: s.text,
      });
      rec.addFinding(
        "STUB_IMPLEMENTATION",
        key,
        `${f.path}:${s.line}`,
        `${s.symbol ?? "A function"} in ${f.path} only throws "not implemented" (line ${s.line}).`,
        s.symbol ?? undefined,
      );
    }
    for (const t of f.tests) {
      testEvidence.set(
        `${f.path}:${t.line}`,
        rec.addEvidence("test_result", `${f.path}:${t.line}`, {
          name: t.name,
          file: f.path,
          line: t.line,
          text: t.text,
          skipped: t.skipped,
          skip_line: t.skipLine,
          // Filled in by the probe stage; "unknown" until the tests ran.
          status: t.skipped ? "skipped" : "unknown",
        }),
      );
    }
    for (const c of f.cliCommands)
      rec.addEvidence("route", `${f.path}:${c.line}`, {
        kind: "cli_command",
        name: c.name,
        file: f.path,
        line: c.line,
      });
  }
  for (const n of graph.nodes.values()) {
    if ((n.kind === "route" || n.kind === "api_handler") && n.line === 1 && n.path)
      rec.addEvidence("route", n.path, {
        method: n.meta.method ?? null,
        path: n.name,
        file: n.path,
        kind: n.kind === "route" ? "page" : "route_handler",
      });
  }

  // --- Env vars: documented vs read -------------------------------------------------------
  const envDocumented = new Map<string, { file: string; line: number; key: string } | null>();
  for (const p of paths.filter((x) => ENV_EXAMPLES.has(posix.basename(x)))) {
    (text.get(p) ?? "").split("\n").forEach((raw, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
      if (!m || envDocumented.get(m[1] as string)) return;
      const key = rec.addEvidence("env_var_documented", `${p}:${i + 1}`, {
        name: m[1] as string,
        file: p,
        line: i + 1,
        text: raw.trim().replace(/=.*$/, "="),
      });
      envDocumented.set(m[1] as string, { file: p, line: i + 1, key });
    });
  }
  const docText = docPaths.map((p) => text.get(p) ?? "").join("\n");
  for (const name of envRead.keys()) {
    if (!envDocumented.has(name) && new RegExp(`\\b${name}\\b`).test(docText))
      envDocumented.set(name, null);
  }
  for (const [name, reads] of [...envRead.entries()].sort()) {
    if (envDocumented.has(name)) continue;
    const first = reads[0] as { file: string; line: number; key: string };
    rec.addFinding(
      "ENV_VAR_UNDOCUMENTED",
      first.key,
      `${first.file}:${first.line}`,
      `${name} is read in ${first.file}:${first.line} but is not in an env example file or the docs.`,
      name,
    );
  }
  for (const [name, doc] of [...envDocumented.entries()].sort()) {
    if (!doc || envRead.has(name)) continue;
    rec.addFinding(
      "ENV_VAR_UNUSED",
      doc.key,
      `${doc.file}:${doc.line}`,
      `${name} is documented in ${doc.file} but never read in code.`,
      name,
    );
  }

  // --- Tests and build scripts -------------------------------------------------------------
  const testCount = facts.reduce((n, f) => n + f.tests.length, 0);
  for (const f of facts)
    for (const t of f.tests.filter((x) => x.skipped)) {
      const key = testEvidence.get(`${f.path}:${t.line}`) as string;
      const line = t.skipLine ?? t.line;
      rec.addFinding(
        "SKIPPED_TESTS",
        key,
        `${f.path}:${line}`,
        `Test "${t.name}" is skipped (${f.path}:${line}).`,
        t.name,
      );
    }
  if (testCount === 0) {
    const key = rec.addEvidence("code_fact", ".", { kind: "tests", test_files: 0, tests: 0 });
    rec.addFinding("NO_TESTS", key, ".", "No test files or test cases were found.");
  }
  if (pkgText && tsconfig) {
    const scripts = (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {};
    if (!scripts.build && !deps.has("next") && !deps.has("vite")) {
      const key = rec.byKey(
        rec.evidence.find((e) => e.kind === "manifest" && e.locator === "package.json")?.key ?? "",
      )?.key;
      if (key)
        rec.addFinding(
          "MISSING_BUILD_SCRIPT",
          key,
          "package.json",
          "A TypeScript project with no build script in package.json.",
        );
    }
  }

  return {
    languages,
    unsupported,
    frameworks,
    packageManager,
    facts,
    graph,
    paths,
    text,
    envRead,
    envDocumented,
    testEvidence,
    fileEvidence,
    hasReadme,
    hasSetupSteps,
    sourceLines,
    markers,
    gaps,
  };
}
