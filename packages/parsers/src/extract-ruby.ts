import type { Node, Tree } from "web-tree-sitter";
import { isTestPath } from "./languages.js";
import { emptyFacts, type FileFacts } from "./types.js";
import { lineOf, lineText, looksLikeUrl, markersIn, NOT_IMPLEMENTED, walk } from "./walk.js";

const ROUTE_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const TESTS = new Set(["it", "specify", "example", "scenario", "test"]);
const SKIPPED_TESTS = new Set(["xit", "xspecify", "xexample", "xscenario"]);
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

/** The value of a Ruby string without interpolation, else null. */
export function rubyString(node: Node | null | undefined): string | null {
  if (node?.type !== "string") return null;
  let out = "";
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "interpolation") return null;
    out += c.type === "escape_sequence" ? (ESCAPES[c.text.slice(1)] ?? c.text) : c.text;
  }
  return out;
}

const argsOf = (call: Node) =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter((c): c is Node => !!c);
const methodOf = (call: Node) => call.childForFieldName("method")?.text ?? "";

/** `ENV["X"]`, `ENV.fetch("X")`: the env var name. */
function envName(node: Node): string | null {
  if (node.type === "element_reference" && node.childForFieldName("object")?.text === "ENV")
    return rubyString(node.namedChildren[1]);
  if (
    node.type === "call" &&
    node.childForFieldName("receiver")?.text === "ENV" &&
    (methodOf(node) === "fetch" || methodOf(node) === "[]")
  )
    return rubyString(argsOf(node)[0]);
  return null;
}

/** A keyword argument's value: `it "x", skip: true` → the `true` node. */
function pairValue(call: Node, key: string): Node | null {
  for (const a of argsOf(call))
    if (a.type === "pair" && a.childForFieldName("key")?.text.replace(/:$/, "") === key)
      return a.childForFieldName("value");
  return null;
}

/** `"#{ENV["API"]}/api/ping"` or `ENV.fetch("API") + "/api/ping"` as a `${...}` template. */
function envTemplate(node: Node): { value: string; envVars: string[] } | null {
  const envVars: string[] = [];
  if (node.type === "string") {
    let value = "";
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === "interpolation") {
        const inner = c.namedChildren[0];
        const env = inner ? envName(inner) : null;
        if (!env || !inner) return null;
        envVars.push(env);
        value += `\${${inner.text}}`;
      } else value += c.type === "escape_sequence" ? (ESCAPES[c.text.slice(1)] ?? c.text) : c.text;
    }
    return envVars.length ? { value, envVars } : null;
  }
  if (node.type === "binary" && node.childForFieldName("operator")?.text === "+") {
    if (node.parent?.type === "binary") return null;
    const parts: Node[] = [];
    const flat = (n: Node) => {
      if (n.type === "binary" && n.childForFieldName("operator")?.text === "+") {
        const l = n.childForFieldName("left");
        const r = n.childForFieldName("right");
        if (l) flat(l);
        if (r) flat(r);
      } else parts.push(n);
    };
    flat(node);
    let value = "";
    for (const p of parts) {
      const env = envName(p);
      const lit = rubyString(p);
      if (env) {
        envVars.push(env);
        value += `\${${p.text}}`;
      } else if (lit !== null) value += lit;
      else return null;
    }
    return envVars.length ? { value, envVars } : null;
  }
  return null;
}

/** `raise X, "msg"`, `raise "msg"`, `raise X.new("msg")`: the raised class and message. */
function raised(call: Node): { cls: string | null; msg: string | null } | null {
  if (call.type !== "call" || call.childForFieldName("receiver")) return null;
  const m = methodOf(call);
  if (m !== "raise" && m !== "fail") return null;
  const [a, b] = argsOf(call);
  if (!a) return { cls: null, msg: null };
  if (a.type === "string") return { cls: "RuntimeError", msg: rubyString(a) };
  if (a.type === "call" && methodOf(a) === "new")
    return { cls: a.childForFieldName("receiver")?.text ?? null, msg: rubyString(argsOf(a)[0]) };
  return { cls: a.text, msg: rubyString(b) };
}

/** Path prefixes from enclosing Rails `namespace :api` / `scope "/v1"` blocks. */
function railsPrefix(node: Node): string {
  const parts: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== "call" || p.childForFieldName("receiver")) continue;
    const m = methodOf(p);
    if (m !== "namespace" && m !== "scope") continue;
    const a = argsOf(p)[0];
    const v = a?.type === "simple_symbol" ? a.text.slice(1) : rubyString(a);
    if (v) parts.unshift(v.replace(/^\/|\/$/g, ""));
  }
  return parts
    .filter(Boolean)
    .map((p) => `/${p}`)
    .join("");
}

function methodBodyStatements(method: Node): Node[] {
  const body = method.childForFieldName("body");
  if (!body) return [];
  if (body.type !== "body_statement") return [body];
  return body.namedChildren.filter((c): c is Node => !!c && c.type !== "comment");
}

export function extractRuby(path: string, tree: Tree, source: string): FileFacts {
  const facts = emptyFacts(path, "ruby");
  const lines = source.split("\n");
  const inTests = isTestPath(path);
  const routesFile = /(^|\/)config\/routes(\/.*)?\.rb$/.test(path);
  const text = (line: number) => lineText(lines, line);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "comment":
        facts.markers.push(...markersIn(node));
        break;
      case "class":
      case "module": {
        const name = node.childForFieldName("name")?.text;
        if (name) facts.symbols.push({ name, kind: "class", line: lineOf(node), exported: true });
        break;
      }
      case "method":
      case "singleton_method": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const line = lineOf(node);
        const owner = node.parent?.type === "body_statement" ? node.parent.parent : node.parent;
        if (owner?.type === "program" || owner?.type === "class" || owner?.type === "module")
          facts.symbols.push({ name, kind: "function", line, exported: !name.startsWith("_") });
        const stmts = methodBodyStatements(node);
        const only = stmts.length === 1 ? (stmts[0] as Node) : null;
        const r = only ? raised(only) : null;
        if (
          only &&
          r &&
          (r.cls === "NotImplementedError" || (r.msg && NOT_IMPLEMENTED.test(r.msg)))
        )
          facts.stubs.push({ symbol: name, line: lineOf(only), text: text(lineOf(only)) });
        // Minitest: def test_x ... end, skipped by a `skip` call in its body.
        if (inTests && /^test_/.test(name)) {
          const skip =
            stmts.find(
              (s) =>
                s.type === "call" && !s.childForFieldName("receiver") && methodOf(s) === "skip",
            ) ??
            (stmts.find((s) => s.type === "identifier" && s.text === "skip") || null);
          facts.tests.push({
            name,
            line,
            text: text(line),
            skipped: !!skip,
            skipLine: skip ? lineOf(skip) : null,
            skipText: skip ? text(lineOf(skip)) : null,
          });
        }
        break;
      }
      case "element_reference": {
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line: lineOf(node), text: text(lineOf(node)) });
        break;
      }
      case "call": {
        const line = lineOf(node);
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line, text: text(line) });
        const m = methodOf(node);
        const receiver = node.childForFieldName("receiver");
        const a = argsOf(node);
        if (!receiver && (m === "require" || m === "require_relative")) {
          const spec = rubyString(a[0]);
          if (spec)
            facts.imports.push({
              specifier: spec,
              line,
              kind: m === "require" ? "ruby" : "ruby-relative",
            });
        }
        // Sinatra `get "/x" do`, Rails `get "/x", to: "c#a"` (relative paths in routes files).
        if (!receiver && ROUTE_VERBS.has(m)) {
          const p = rubyString(a[0]);
          if (p !== null && (p.startsWith("/") || routesFile)) {
            const full = `${railsPrefix(node)}/${p.replace(/^\//, "")}`.replace(/\/$/, "") || "/";
            facts.routes.push({
              method: m.toUpperCase(),
              path: full,
              line,
              text: text(line),
              handler: rubyString(pairValue(node, "to")),
            });
          }
        }
        if (!receiver && m === "root" && routesFile) {
          facts.routes.push({
            method: "GET",
            path: railsPrefix(node) || "/",
            line,
            text: text(line),
            handler: rubyString(a[0]) ?? rubyString(pairValue(node, "to")),
          });
        }
        // RSpec / minitest-spec cases.
        if (inTests && !receiver && (TESTS.has(m) || SKIPPED_TESTS.has(m))) {
          const name = rubyString(a[0]);
          if (name !== null && node.childForFieldName("block")) {
            const skipArg = pairValue(node, "skip");
            let skipNode: Node | null =
              SKIPPED_TESTS.has(m) || (skipArg && skipArg.type !== "false") ? node : null;
            if (!skipNode) {
              const block = node.childForFieldName("block");
              const body = block?.childForFieldName("body");
              for (const s of body?.namedChildren ?? []) {
                if (
                  s &&
                  ((s.type === "call" &&
                    !s.childForFieldName("receiver") &&
                    /^(skip|pending)$/.test(methodOf(s))) ||
                    (s.type === "identifier" && /^(skip|pending)$/.test(s.text)))
                ) {
                  skipNode = s;
                  break;
                }
              }
            }
            facts.tests.push({
              name,
              line,
              text: text(line),
              skipped: !!skipNode,
              skipLine: skipNode ? lineOf(skipNode) : null,
              skipText: skipNode ? text(lineOf(skipNode)) : null,
            });
          }
        }
        const r = raised(node);
        if (r?.msg?.trim())
          facts.messages.push({ value: r.msg, line, text: text(line), kind: "throw" });
        break;
      }
      case "binary": {
        const tpl = envTemplate(node);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
          facts.urlLiterals.push({
            ...tpl,
            line: lineOf(node),
            template: true,
            text: text(lineOf(node)),
          });
        break;
      }
      case "string": {
        const line = lineOf(node);
        const v = rubyString(node);
        if (v !== null) {
          if (looksLikeUrl(v))
            facts.urlLiterals.push({
              value: v,
              line,
              template: false,
              envVars: [],
              text: text(line),
            });
        } else {
          const tpl = envTemplate(node);
          if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
            facts.urlLiterals.push({ ...tpl, line, template: true, text: text(line) });
        }
        break;
      }
      default:
        break;
    }
  }
  return facts;
}
