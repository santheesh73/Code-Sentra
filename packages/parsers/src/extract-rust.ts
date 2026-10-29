import type { Node, Tree } from "web-tree-sitter";
import { emptyFacts, type FileFacts } from "./types.js";
import { lineOf, lineText, looksLikeUrl, markersIn, NOT_IMPLEMENTED, walk } from "./walk.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
/** Free functions and chained methods that name a route's method: axum `get(h).post(h2)`, actix `web::get().to(h)`. */
const METHOD_FN = new Set(HTTP_METHODS);
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  "'": "'",
  "\\": "\\",
};
/** `std::env::var("X")` / `env::var_os("X")`, optionally unwrapped: one direct env read. */
const ENV_ARG =
  /^(?:std::)?env::var(?:_os)?\(\s*"([^"\\]+)"\s*\)(?:\.(?:unwrap|expect|unwrap_or|unwrap_or_default|unwrap_or_else)\([^()]*(?:\([^()]*\)[^()]*)*\))?$/;
const ENV_READ = /\b(?:std::)?env::var(?:_os)?\(\s*"([^"\\]+)"\s*\)/g;

/** The value of a Rust string literal (plain or raw), or null for anything else. */
export function rustString(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "raw_string_literal")
    return node.namedChildren.find((c) => c?.type === "string_content")?.text ?? "";
  if (node.type !== "string_literal") return null;
  return node.namedChildren
    .map((c) => {
      if (!c) return "";
      if (c.type === "escape_sequence") return ESCAPES[c.text.slice(1)] ?? c.text;
      return c.text;
    })
    .join("");
}

const lastSegment = (s: string) => s.split("::").pop() ?? s;
const args = (call: Node) =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter((c): c is Node => !!c);

/** The attribute items right before an item (Rust attributes are the item's siblings). */
function attributesOf(item: Node): Node[] {
  const out: Node[] = [];
  let prev = item.previousNamedSibling;
  while (prev && (prev.type === "attribute_item" || prev.type === "line_comment")) {
    if (prev.type === "attribute_item") out.unshift(prev);
    prev = prev.previousNamedSibling;
  }
  return out;
}
const attrOf = (item: Node) => item.namedChildren.find((c) => c?.type === "attribute") ?? null;
const attrName = (item: Node) => lastSegment(attrOf(item)?.namedChildren[0]?.text ?? "");
const attrPath = (item: Node) => attrOf(item)?.namedChildren[0]?.text ?? "";

/** `std::env::var("X")` / `env::var_os("X")` as a call: the env var name. */
function envName(node: Node): string | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function")?.text ?? "";
  if (!/^(?:std::)?env::var(?:_os)?$/.test(fn)) return null;
  return rustString(args(node)[0]);
}

/** The env read behind `env::var("X").unwrap()` (and `expect`, `unwrap_or…`), else null. */
function unwrappedEnv(node: Node): string | null {
  return ENV_ARG.exec(node.text.replace(/\s+/g, ""))?.[1] ?? null;
}

/** A macro's arguments as source text, split at its top-level commas. */
function macroArgs(macro: Node, source: string): { text: string; nodes: Node[] }[] {
  const tt = macro.namedChildren.find((c) => c?.type === "token_tree");
  if (!tt) return [];
  const groups: { text: string; nodes: Node[] }[] = [];
  let cur: Node[] = [];
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0] as Node;
    const last = cur.at(-1) as Node;
    groups.push({ text: source.slice(first.startIndex, last.endIndex), nodes: cur });
    cur = [];
  };
  // The tree's first and last children are the delimiters.
  for (const c of tt.children.slice(1, -1)) {
    if (!c) continue;
    if (c.type === ",") flush();
    else cur.push(c);
  }
  flush();
  return groups;
}

/** The first argument of a macro when it is a string literal (`panic!("msg")`). */
function macroMessage(macro: Node, source: string): string | null {
  const first = macroArgs(macro, source)[0];
  return first?.nodes.length === 1 ? rustString(first.nodes[0]) : null;
}

/**
 * A URL built from env vars: `format!("{}/api/ping", env::var("API").unwrap())` or
 * `env::var("API").unwrap() + "/api/ping"`, written `${env::var("API")}/api/ping` (the template
 * form Link matches by static suffix). Only direct env reads count.
 */
function envTemplate(node: Node, source: string): { value: string; envVars: string[] } | null {
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    if (node.parent?.type === "binary_expression") return null;
    const parts: Node[] = [];
    const flat = (n: Node) => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
        const l = n.childForFieldName("left");
        const r = n.childForFieldName("right");
        if (l) flat(l);
        if (r) flat(r);
      } else parts.push(n.type === "reference_expression" ? (n.namedChildren.at(-1) ?? n) : n);
    };
    flat(node);
    const envVars: string[] = [];
    let value = "";
    for (const p of parts) {
      const env = unwrappedEnv(p);
      const lit = rustString(p);
      if (env) {
        envVars.push(env);
        value += `\${env::var("${env}")}`;
      } else if (lit !== null) value += lit;
      else return null;
    }
    return envVars.length ? { value, envVars } : null;
  }
  if (
    node.type === "macro_invocation" &&
    lastSegment(node.childForFieldName("macro")?.text ?? "") === "format"
  ) {
    const [fmt, ...rest] = macroArgs(node, source);
    const format = fmt?.nodes.length === 1 ? rustString(fmt.nodes[0]) : null;
    if (format === null) return null;
    const envVars: string[] = [];
    let i = 0;
    let ok = true;
    const value = format.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (all, spec: string | undefined) => {
      if (all === "{{") return "{";
      if (all === "}}") return "}";
      // Positional `{}` / `{:?}` only; named or numbered captures are not followed.
      if (spec && !spec.startsWith(":")) {
        ok = false;
        return all;
      }
      const arg = rest[i++];
      const env = arg ? (ENV_ARG.exec(arg.text.replace(/\s+/g, ""))?.[1] ?? null) : null;
      if (env) {
        envVars.push(env);
        return `\${env::var("${env}")}`;
      }
      ok = false;
      return all;
    });
    return ok && envVars.length ? { value, envVars } : null;
  }
  return null;
}

/** `todo!()`, `unimplemented!()` or `panic!("not implemented")` as a body's only statement. */
function stubOf(fn: Node, source: string): Node | null {
  const body = fn.childForFieldName("body");
  const stmts = (body?.namedChildren ?? []).filter(
    (c): c is Node => !!c && c.type !== "line_comment" && c.type !== "block_comment",
  );
  if (stmts.length !== 1) return null;
  const only = stmts[0] as Node;
  const macro = only.type === "expression_statement" ? only.namedChildren[0] : only;
  if (macro?.type !== "macro_invocation") return null;
  const name = lastSegment(macro.childForFieldName("macro")?.text ?? "");
  if (name === "todo" || name === "unimplemented") return only;
  const msg = name === "panic" ? macroMessage(macro, source) : null;
  return msg && NOT_IMPLEMENTED.test(msg) ? only : null;
}

/** `use a::{b, c::D as E}` as the full paths it names: `a::b`, `a::c::D`. */
function usePaths(node: Node, prefix = ""): string[] {
  const join = (p: string) => (prefix ? `${prefix}::${p}` : p);
  switch (node.type) {
    case "identifier":
    case "scoped_identifier":
    case "crate":
    case "super":
      return [join(node.text)];
    case "self":
      return prefix ? [prefix] : ["self"];
    case "use_as_clause": {
      const p = node.childForFieldName("path");
      return p ? usePaths(p, prefix) : [];
    }
    case "use_wildcard": {
      const p = node.namedChildren[0];
      return p ? usePaths(p, prefix) : prefix ? [prefix] : [];
    }
    case "scoped_use_list": {
      const p = node.childForFieldName("path")?.text;
      const list = node.childForFieldName("list");
      return list ? usePaths(list, p ? join(p) : prefix) : [];
    }
    case "use_list":
      return node.namedChildren.flatMap((c) => (c ? usePaths(c, prefix) : []));
    default:
      return [];
  }
}

/** `.nest("/api", Router::new()…)` prefixes around an axum `.route(...)` call. */
function nestPrefix(call: Node): string {
  let prefix = "";
  for (let n = call.parent; n; n = n.parent) {
    if (n.type !== "arguments") continue;
    const outer = n.parent;
    const fn = outer?.childForFieldName("function");
    if (outer?.type !== "call_expression" || fn?.type !== "field_expression") continue;
    if (fn.childForFieldName("field")?.text !== "nest") continue;
    const p = rustString(args(outer)[0]);
    if (p !== null) prefix = p.replace(/\/$/, "") + prefix;
  }
  return prefix;
}

/** The methods and handler of an axum `get(h).post(h2)` / actix `web::get().to(h)` argument. */
function methodRouter(arg: Node): { method: string; handler: string | null }[] {
  const out: { method: string; handler: string | null; at: number }[] = [];
  let to: string | null = null;
  for (const n of walk(arg)) {
    if (n.type !== "call_expression") continue;
    const fn = n.childForFieldName("function");
    if (!fn) continue;
    const name =
      fn.type === "field_expression"
        ? (fn.childForFieldName("field")?.text ?? "")
        : lastSegment(fn.text);
    const a = args(n);
    if (name === "to" && a[0]) to = lastSegment(a[0].text);
    else if (METHOD_FN.has(name))
      out.push({
        method: name.toUpperCase(),
        handler: a[0] ? lastSegment(a[0].text) : null,
        at: (fn.type === "field_expression" ? fn.childForFieldName("field") : fn)?.startIndex ?? 0,
      });
  }
  // A chain `get(a).post(b)` is walked outermost first; report methods in source order.
  return out
    .sort((x, y) => x.at - y.at)
    .map((r) => ({ method: r.method, handler: r.handler ?? to }));
}

export function extractRust(path: string, tree: Tree, source: string): FileFacts {
  const facts = emptyFacts(path, "rust");
  const lines = source.split("\n");
  const text = (line: number) => lineText(lines, line);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "line_comment":
      case "block_comment":
        facts.markers.push(...markersIn(node));
        break;
      case "use_declaration": {
        const arg = node.childForFieldName("argument");
        for (const spec of arg ? usePaths(arg) : [])
          facts.imports.push({ specifier: spec, line: lineOf(node), kind: "rust" });
        break;
      }
      case "mod_item": {
        const name = node.childForFieldName("name")?.text;
        if (name && !node.childForFieldName("body"))
          facts.imports.push({ specifier: name, line: lineOf(node), kind: "rust-mod" });
        break;
      }
      case "struct_item":
      case "enum_item":
      case "trait_item":
      case "type_item": {
        const name = node.childForFieldName("name")?.text;
        if (name && node.parent?.type === "source_file")
          facts.symbols.push({
            name,
            kind: "class",
            line: lineOf(node),
            exported: node.namedChildren.some((c) => c?.type === "visibility_modifier"),
          });
        break;
      }
      case "const_item":
      case "static_item": {
        const name = node.childForFieldName("name")?.text;
        if (name && node.parent?.type === "source_file")
          facts.symbols.push({
            name,
            kind: "variable",
            line: lineOf(node),
            exported: node.namedChildren.some((c) => c?.type === "visibility_modifier"),
          });
        break;
      }
      case "function_item": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const line = lineOf(node);
        const container = node.parent;
        const topLevel =
          container?.type === "source_file" ||
          (container?.type === "declaration_list" &&
            container.parent?.type === "impl_item" &&
            container.parent.parent?.type === "source_file");
        if (topLevel)
          facts.symbols.push({
            name,
            kind: "function",
            line,
            exported: node.namedChildren.some((c) => c?.type === "visibility_modifier"),
          });
        const stub = stubOf(node, source);
        if (stub) facts.stubs.push({ symbol: name, line: lineOf(stub), text: text(lineOf(stub)) });

        const attrs = attributesOf(node);
        // #[test], #[tokio::test], #[rstest]; #[ignore] skips. Unit tests live in any file.
        if (
          attrs.some((a) => attrName(a) === "test" || ["rstest", "test_case"].includes(attrPath(a)))
        ) {
          const skip = attrs.find((a) => attrName(a) === "ignore") ?? null;
          facts.tests.push({
            name,
            line,
            text: text(line),
            skipped: !!skip,
            skipLine: skip ? lineOf(skip) : null,
            skipText: skip ? text(lineOf(skip)) : null,
          });
        }
        // Actix and Rocket: #[get("/x")] on the handler.
        for (const a of attrs) {
          const method = attrName(a);
          if (!METHOD_FN.has(method)) continue;
          const tt = attrOf(a)?.childForFieldName("arguments");
          const p = rustString(tt?.namedChildren[0]);
          if (p?.startsWith("/"))
            facts.routes.push({
              method: method.toUpperCase(),
              path: p,
              line: lineOf(a),
              text: text(lineOf(a)),
              handler: name,
            });
        }
        break;
      }
      case "call_expression": {
        const line = lineOf(node);
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line, text: text(line) });
        const fn = node.childForFieldName("function");
        // axum `.route("/x", get(h))`, actix `.route("/x", web::get().to(h))`
        if (fn?.type === "field_expression" && fn.childForFieldName("field")?.text === "route") {
          const [p, handler] = args(node);
          const routePath = rustString(p);
          if (routePath?.startsWith("/") && handler) {
            const at = lineOf(fn.childForFieldName("field") as Node);
            const full = nestPrefix(node) + routePath;
            for (const r of methodRouter(handler))
              facts.routes.push({
                method: r.method,
                path: full,
                line: at,
                text: text(at),
                handler: r.handler,
              });
          }
        }
        break;
      }
      case "binary_expression": {
        const tpl = envTemplate(node, source);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
          facts.urlLiterals.push({
            ...tpl,
            line: lineOf(node),
            template: true,
            text: text(lineOf(node)),
          });
        break;
      }
      case "macro_invocation": {
        const name = lastSegment(node.childForFieldName("macro")?.text ?? "");
        const line = lineOf(node);
        // Calls inside a macro's arguments are tokens, not expressions: read env vars lexically.
        if (node.parent?.type !== "token_tree")
          for (const m of node.text.matchAll(ENV_READ)) {
            const at = line + node.text.slice(0, m.index).split("\n").length - 1;
            facts.envReads.push({ name: m[1] as string, line: at, text: text(at) });
          }
        const tpl = envTemplate(node, source);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
          facts.urlLiterals.push({ ...tpl, line, template: true, text: text(line) });
        const msg = macroMessage(node, source);
        if (!msg?.trim()) break;
        const kind =
          name === "panic" || name === "bail"
            ? "throw"
            : name === "anyhow" || name === "eyre"
              ? "error"
              : name === "eprintln" || name === "error"
                ? "console"
                : null;
        if (kind) facts.messages.push({ value: msg, line, text: text(line), kind });
        break;
      }
      case "string_literal":
      case "raw_string_literal": {
        if (node.parent?.parent?.type === "attribute") break;
        const v = rustString(node);
        if (v !== null && looksLikeUrl(v)) {
          const line = lineOf(node);
          facts.urlLiterals.push({
            value: v,
            line,
            template: false,
            envVars: [],
            text: text(line),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  // An env read inside a macro is found both as a token run and, for some macros, a call.
  const seen = new Set<string>();
  facts.envReads = facts.envReads
    .filter((e) => {
      const k = `${e.name}:${e.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.line - b.line);
  return facts;
}
