import type { Node, Tree } from "web-tree-sitter";
import { isTestPath } from "./languages.js";
import { emptyFacts, type FileFacts } from "./types.js";
import { lineOf, lineText, looksLikeUrl, markersIn, NOT_IMPLEMENTED, walk } from "./walk.js";

/** net/http, Gin and Echo (`GET`), Chi (`Get`): the method is the selector's name. */
const ROUTE_METHODS = new Map(
  ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].flatMap((m) => [
    [m, m],
    [m[0] + m.slice(1).toLowerCase(), m],
  ]),
);
/** Go 1.22 `mux.HandleFunc("GET /items/{id}", h)`: an optional method before the path. */
const MUX_PATTERN = /^(?:([A-Z]+)\s+)?(?:[^/\s]*)(\/\S*)$/;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

/** The value of a Go string literal (interpreted or raw), or null for anything else. */
export function goString(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "raw_string_literal") return node.text.slice(1, -1);
  if (node.type !== "interpreted_string_literal") return null;
  return node.namedChildren
    .map((c) => {
      if (!c) return "";
      if (c.type === "escape_sequence") return ESCAPES[c.text.slice(1)] ?? c.text;
      return c.text;
    })
    .join("");
}

const args = (call: Node) =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter((c): c is Node => !!c);

/** `os.Getenv("X")` / `os.LookupEnv("X")`: the env var name. */
function envName(node: Node): string | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function")?.text;
  if (fn !== "os.Getenv" && fn !== "os.LookupEnv") return null;
  return goString(args(node)[0]);
}

/**
 * A URL built from env vars: `os.Getenv("API") + "/api/ping"` or
 * `fmt.Sprintf("%s/api/ping", os.Getenv("API"))`, written as `${os.Getenv("API")}/api/ping`
 * (the template form Link matches by static suffix). Only direct env reads count.
 */
function envTemplate(node: Node): { value: string; envVars: string[] } | null {
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    if (node.parent?.type === "binary_expression") return null; // the outermost sum only
    const parts: Node[] = [];
    const flat = (n: Node) => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
        const l = n.childForFieldName("left");
        const r = n.childForFieldName("right");
        if (l) flat(l);
        if (r) flat(r);
      } else parts.push(n);
    };
    flat(node);
    const envVars: string[] = [];
    let value = "";
    for (const p of parts) {
      const env = envName(p);
      const lit = goString(p);
      if (env) {
        envVars.push(env);
        value += `\${${p.text}}`;
      } else if (lit !== null) value += lit;
      else return null;
    }
    return envVars.length ? { value, envVars } : null;
  }
  if (
    node.type === "call_expression" &&
    node.childForFieldName("function")?.text === "fmt.Sprintf"
  ) {
    const [fmt, ...rest] = args(node);
    const format = goString(fmt);
    if (format === null) return null;
    const envVars: string[] = [];
    let i = 0;
    let ok = true;
    const value = format.replace(/%[-+# 0-9.]*[a-zA-Z%]/g, (verb) => {
      if (verb === "%%") return "%";
      const arg = rest[i++];
      const env = arg ? envName(arg) : null;
      if (env) {
        envVars.push(env);
        return `\${${arg?.text}}`;
      }
      ok = false;
      return verb;
    });
    return ok && envVars.length ? { value, envVars } : null;
  }
  return null;
}

/** `panic("not implemented")` (or a returned errors.New/fmt.Errorf saying so) as a body's only statement. */
function stubOf(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  const list = body?.namedChildren.find((c) => c?.type === "statement_list");
  const stmts = (list?.namedChildren ?? []).filter((c): c is Node => !!c && c.type !== "comment");
  if (stmts.length !== 1) return null;
  const only = stmts[0] as Node;
  const call =
    only.type === "expression_statement"
      ? only.namedChildren[0]
      : only.type === "return_statement"
        ? only.namedChildren[0]?.namedChildren.at(-1)
        : null;
  if (call?.type !== "call_expression") return null;
  const fn2 = call.childForFieldName("function")?.text ?? "";
  if (only.type === "expression_statement" && fn2 !== "panic") return null;
  if (only.type === "return_statement" && fn2 !== "errors.New" && fn2 !== "fmt.Errorf") return null;
  const msg = goString(args(call)[0]);
  return msg && NOT_IMPLEMENTED.test(msg) ? only : null;
}

/** `t.Skip(...)` / `t.Skipf` / `t.SkipNow()` anywhere in a test body: the first one. */
function skipIn(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  if (!body) return null;
  for (const n of walk(body)) {
    if (n.type !== "call_expression") continue;
    const f = n.childForFieldName("function");
    if (f?.type !== "selector_expression") continue;
    const name = f.childForFieldName("field")?.text ?? "";
    if (/^Skip(f|Now)?$/.test(name)) return n;
  }
  return null;
}

export function extractGo(path: string, tree: Tree, source: string): FileFacts {
  const facts = emptyFacts(path, "go");
  const lines = source.split("\n");
  const inTests = isTestPath(path);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "comment":
        facts.markers.push(...markersIn(node));
        break;
      case "import_spec": {
        const spec = goString(node.childForFieldName("path"));
        if (spec) facts.imports.push({ specifier: spec, line: lineOf(node), kind: "go" });
        break;
      }
      case "function_declaration":
      case "method_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const line = lineOf(node);
        facts.symbols.push({
          name,
          kind: "function",
          line,
          exported: /^[A-Z]/.test(name),
        });
        const stub = stubOf(node);
        if (stub)
          facts.stubs.push({
            symbol: name,
            line: lineOf(stub),
            text: lineText(lines, lineOf(stub)),
          });
        if (inTests && node.type === "function_declaration" && /^Test[A-Z0-9_]/.test(name)) {
          const skip = skipIn(node);
          facts.tests.push({
            name,
            line,
            text: lineText(lines, line),
            skipped: !!skip,
            skipLine: skip ? lineOf(skip) : null,
            skipText: skip ? lineText(lines, lineOf(skip)) : null,
          });
        }
        break;
      }
      case "type_spec": {
        const name = node.childForFieldName("name")?.text;
        if (name && node.parent?.parent?.type === "source_file")
          facts.symbols.push({
            name,
            kind: "class",
            line: lineOf(node),
            exported: /^[A-Z]/.test(name),
          });
        break;
      }
      case "var_spec":
      case "const_spec": {
        if (node.parent?.parent?.type !== "source_file" && node.parent?.type !== "source_file")
          break;
        for (const n of node.childrenForFieldName("name"))
          if (n?.text)
            facts.symbols.push({
              name: n.text,
              kind: "variable",
              line: lineOf(node),
              exported: /^[A-Z]/.test(n.text),
            });
        break;
      }
      case "call_expression": {
        const line = lineOf(node);
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line, text: lineText(lines, line) });
        const fn = node.childForFieldName("function");
        const a = args(node);
        if (fn?.type === "selector_expression") {
          const field = fn.childForFieldName("field")?.text ?? "";
          // http.HandleFunc("/x", h), mux.Handle("GET /x/{id}", h)
          if (field === "HandleFunc" || field === "Handle") {
            const m = MUX_PATTERN.exec(goString(a[0]) ?? "");
            if (m)
              facts.routes.push({
                method: m[1] ?? "GET",
                path: m[2] as string,
                line,
                text: lineText(lines, line),
                handler: a[1]?.text.split(".").pop() ?? null,
              });
          }
          // r.GET("/x", h) (Gin, Echo), r.Get("/x", h) (Chi)
          const method = ROUTE_METHODS.get(field);
          const p = goString(a[0]);
          if (method && p?.startsWith("/") && a.length >= 2)
            facts.routes.push({
              method,
              path: p,
              line,
              text: lineText(lines, line),
              handler: a.at(-1)?.text.split(".").pop() ?? null,
            });
          const callee = fn.text;
          const msg = goString(a[0]);
          if (msg?.trim()) {
            if (callee === "errors.New" || callee === "fmt.Errorf")
              facts.messages.push({ value: msg, line, text: lineText(lines, line), kind: "error" });
            else if (/^log\.(Fatal|Panic)(f|ln)?$/.test(callee))
              facts.messages.push({
                value: msg,
                line,
                text: lineText(lines, line),
                kind: "console",
              });
          }
        } else if (fn?.text === "panic") {
          const msg = goString(a[0]);
          if (msg?.trim())
            facts.messages.push({ value: msg, line, text: lineText(lines, line), kind: "throw" });
        }
        const tpl = envTemplate(node);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
          facts.urlLiterals.push({ ...tpl, line, template: true, text: lineText(lines, line) });
        break;
      }
      case "binary_expression": {
        const tpl = envTemplate(node);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value))) {
          const line = lineOf(node);
          facts.urlLiterals.push({ ...tpl, line, template: true, text: lineText(lines, line) });
        }
        break;
      }
      case "interpreted_string_literal":
      case "raw_string_literal": {
        if (node.parent?.type === "import_spec") break;
        const v = goString(node);
        if (v !== null && looksLikeUrl(v)) {
          const line = lineOf(node);
          facts.urlLiterals.push({
            value: v,
            line,
            template: false,
            envVars: [],
            text: lineText(lines, line),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return facts;
}
