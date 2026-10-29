import type { Node, Tree } from "web-tree-sitter";
import { isTestPath } from "./languages.js";
import { emptyFacts, type FileFacts } from "./types.js";
import { lineOf, lineText, looksLikeUrl, markersIn, NOT_IMPLEMENTED, walk } from "./walk.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  $: "$",
  "\\": "\\",
};

/**
 * The value of a PHP string literal: single-quoted, or double-quoted without interpolation.
 * Null for anything else (interpolated strings, heredocs).
 */
export function phpString(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string")
    return node.namedChildren
      .map((c) => (c?.type === "escape_sequence" ? c.text.slice(1) : (c?.text ?? "")))
      .join("");
  if (node.type !== "encapsed_string") return null;
  let out = "";
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "string_content") out += c.text;
    else if (c.type === "escape_sequence") out += ESCAPES[c.text.slice(1)] ?? c.text;
    else return null;
  }
  return out;
}

/** The argument expressions of a call. */
function args(call: Node): Node[] {
  const list =
    call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c?.type === "arguments");
  return (list?.namedChildren ?? [])
    .filter((c): c is Node => c?.type === "argument")
    .map((a) => a.namedChildren.at(-1))
    .filter((c): c is Node => !!c);
}
/** Named arguments (`methods: ['GET']`) of a call or attribute. */
function namedArg(call: Node, name: string): Node | null {
  const list = call.childForFieldName("arguments") ?? call.childForFieldName("parameters");
  for (const a of list?.namedChildren ?? [])
    if (a?.type === "argument" && a.childForFieldName("name")?.text === name)
      return a.namedChildren.at(-1) ?? null;
  return null;
}
const lastName = (s: string) => s.replace(/^\\/, "").split("\\").pop() ?? s;
const callName = (call: Node) =>
  call.type === "function_call_expression"
    ? lastName(call.childForFieldName("function")?.text ?? "")
    : "";

/** `getenv('X')`, `env('X')` (Laravel) and `$_ENV['X']`: the env var name. */
function envName(node: Node): string | null {
  if (node.type === "function_call_expression") {
    const fn = callName(node);
    if (fn !== "getenv" && fn !== "env") return null;
    return phpString(args(node)[0]);
  }
  if (node.type === "subscript_expression") {
    const [base, key] = node.namedChildren;
    if (base?.text !== "$_ENV") return null;
    return phpString(key);
  }
  return null;
}

/**
 * A URL built from env vars: `getenv('API') . '/api/ping'` or
 * `sprintf('%s/api/ping', getenv('API'))`, written `${getenv('API')}/api/ping` (the template
 * form Link matches by static suffix). Only direct env reads count.
 */
function envTemplate(node: Node): { value: string; envVars: string[] } | null {
  const envVars: string[] = [];
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === ".") {
    if (node.parent?.type === "binary_expression") return null;
    const parts: Node[] = [];
    const flat = (n: Node) => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === ".") {
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
      const lit = phpString(p);
      if (env) {
        envVars.push(env);
        value += `\${${p.text}}`;
      } else if (lit !== null) value += lit;
      else return null;
    }
    return envVars.length ? { value, envVars } : null;
  }
  if (node.type === "function_call_expression" && callName(node) === "sprintf") {
    const [fmt, ...rest] = args(node);
    const format = phpString(fmt);
    if (format === null) return null;
    let i = 0;
    let ok = true;
    const value = format.replace(/%(?:\d+\$)?[-+ 0'.#\d]*[a-zA-Z%]/g, (verb) => {
      if (verb === "%%") return "%";
      const arg = rest[i++];
      const env = arg ? envName(arg) : null;
      if (env && arg) {
        envVars.push(env);
        return `\${${arg.text}}`;
      }
      ok = false;
      return verb;
    });
    return ok && envVars.length ? { value, envVars } : null;
  }
  return null;
}

/** The exception a `throw new X(...)` statement throws, with its message. */
function thrown(stmt: Node): { type: string; message: string | null } | null {
  const expr = stmt.type === "expression_statement" ? stmt.namedChildren[0] : stmt;
  if (expr?.type !== "throw_expression") return null;
  const created = expr.namedChildren[0];
  if (created?.type !== "object_creation_expression") return null;
  const type = lastName(created.namedChildren[0]?.text ?? "");
  return { type, message: phpString(args(created)[0]) };
}

/** `throw new LogicException('Not implemented')` (or `BadMethodCallException`) as the only statement. */
function stubOf(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  const stmts = (body?.namedChildren ?? []).filter((c): c is Node => !!c && c.type !== "comment");
  if (stmts.length !== 1) return null;
  const t = thrown(stmts[0] as Node);
  if (!t) return null;
  if (/NotImplemented/.test(t.type)) return stmts[0] as Node;
  if (t.message === null && t.type === "BadMethodCallException") return stmts[0] as Node;
  return t.message && NOT_IMPLEMENTED.test(t.message) ? (stmts[0] as Node) : null;
}

const attributeNames = (decl: Node) =>
  (decl.childForFieldName("attributes")?.descendantsOfType("attribute") ?? [])
    .filter((a): a is Node => !!a)
    .map((a) => ({ node: a, name: lastName(a.namedChildren[0]?.text ?? "") }));

const routePath = (p: string) => (p.startsWith("/") ? p : `/${p}`);
const joinPath = (prefix: string, p: string) =>
  `/${[prefix, p]
    .map((x) => x.replace(/^\/|\/$/g, ""))
    .filter(Boolean)
    .join("/")}`;

/** The handler a route names: `[C::class, 'm']` → m, `'C@m'` / `'C:m'` → m, `C::class` → C. */
function handlerOf(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "array_creation_expression") {
    const items = node.namedChildren.filter((c) => c?.type === "array_element_initializer");
    const m = phpString(items[1]?.namedChildren[0]);
    if (m) return m;
    return items[0] ? handlerOf(items[0].namedChildren[0] ?? undefined) : null;
  }
  if (node.type === "class_constant_access_expression")
    return lastName(node.namedChildren[0]?.text ?? "");
  const s = phpString(node);
  if (s) return s.split(/[@:]/).pop() ?? s;
  return null;
}

/**
 * Prefixes from the groups around a route call: Laravel `Route::prefix('api')->group(fn)` and
 * `Route::group(['prefix' => 'api'], fn)`, Slim `$app->group('/api', fn)`.
 */
function groupPrefix(call: Node): string {
  let prefix = "";
  for (let n = call.parent; n; n = n.parent) {
    if (n.type !== "anonymous_function" && n.type !== "arrow_function") continue;
    const outer = n.parent?.parent?.parent; // argument → arguments → call
    if (!outer) continue;
    const name = outer.childForFieldName("name")?.text;
    if (name !== "group") continue;
    let p: string | null = null;
    const first = args(outer)[0];
    if (outer.type === "member_call_expression" && first && first !== n) p = phpString(first);
    if (first?.type === "array_creation_expression")
      for (const el of first.namedChildren)
        if (phpString(el?.namedChildren[0]) === "prefix") p = phpString(el?.namedChildren[1]);
    // Route::prefix('api')->group(...): the prefix is on the object chain.
    for (let o = outer.childForFieldName("object"); o && p === null; ) {
      if (
        (o.type === "scoped_call_expression" || o.type === "member_call_expression") &&
        o.childForFieldName("name")?.text === "prefix"
      )
        p = phpString(args(o)[0]);
      o = o.childForFieldName("object") ?? o.childForFieldName("scope");
    }
    if (p) prefix = joinPath(p, prefix);
  }
  return prefix === "/" ? "" : prefix;
}

export function extractPhp(path: string, tree: Tree, source: string): FileFacts {
  const facts = emptyFacts(path, "php");
  const lines = source.split("\n");
  const text = (line: number) => lineText(lines, line);
  const inTests = isTestPath(path);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "comment":
        facts.markers.push(...markersIn(node));
        break;
      case "namespace_use_declaration": {
        // `use function` / `use const` import functions and constants, not classes.
        const kindOf = (n: Node | null | undefined) =>
          n?.children.find((c) => c?.type === "function" || c?.type === "const");
        if (kindOf(node)) break;
        const group = node.childForFieldName("body");
        const prefix = group
          ? (node.namedChildren.find((c) => c?.type === "namespace_name")?.text ?? "")
          : "";
        const clauses = (group ?? node).namedChildren.filter(
          (c) => c?.type === "namespace_use_clause",
        );
        for (const c of clauses) {
          if (kindOf(c)) continue;
          const name = c?.namedChildren.find(
            (x) => x?.type === "qualified_name" || x?.type === "name",
          )?.text;
          if (name)
            facts.imports.push({
              specifier: (prefix ? `${prefix}\\${name}` : name).replace(/^\\/, ""),
              line: lineOf(node),
              kind: "php",
            });
        }
        break;
      }
      case "require_expression":
      case "require_once_expression":
      case "include_expression":
      case "include_once_expression": {
        const arg = node.namedChildren[0];
        let spec: string | null = null;
        if (arg?.type === "binary_expression" && arg.childForFieldName("left")?.text === "__DIR__")
          spec = phpString(arg.childForFieldName("right"))?.replace(/^\//, "") ?? null;
        else spec = phpString(arg);
        if (spec) facts.imports.push({ specifier: spec, line: lineOf(node), kind: "php-require" });
        break;
      }
      case "class_declaration":
      case "interface_declaration":
      case "trait_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name)
          facts.symbols.push({
            name,
            kind: "class",
            line: lineOf(node.childForFieldName("name") as Node),
            exported: true,
          });
        break;
      }
      case "function_definition": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const line = lineOf(node);
        if (node.parent?.type === "program" || node.parent?.parent?.type === "namespace_definition")
          facts.symbols.push({ name, kind: "function", line, exported: true });
        const stub = stubOf(node);
        if (stub) facts.stubs.push({ symbol: name, line: lineOf(stub), text: text(lineOf(stub)) });
        break;
      }
      case "method_declaration": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text;
        if (!name || !nameNode) break;
        const line = lineOf(nameNode);
        const visibility =
          node.namedChildren.find((c) => c?.type === "visibility_modifier")?.text ?? "public";
        facts.symbols.push({ name, kind: "function", line, exported: visibility === "public" });
        const stub = stubOf(node);
        if (stub) facts.stubs.push({ symbol: name, line: lineOf(stub), text: text(lineOf(stub)) });

        const cls = node.parent?.parent;
        const attrs = attributeNames(node);
        // PHPUnit: test* methods (or #[Test], or a `@test` docblock) of a *TestCase subclass.
        const base = cls?.namedChildren.find((c) => c?.type === "base_clause")?.text ?? "";
        const doc =
          node.previousNamedSibling?.type === "comment" ? node.previousNamedSibling.text : "";
        if (
          /TestCase\b/.test(base) &&
          (/^test/.test(name) || attrs.some((a) => a.name === "Test") || /@test\b/.test(doc))
        ) {
          const skip = node
            .childForFieldName("body")
            ?.descendantsOfType(["member_call_expression", "scoped_call_expression"])
            .find((c) =>
              /^mark(TestSkipped|TestIncomplete)$/.test(c?.childForFieldName("name")?.text ?? ""),
            );
          facts.tests.push({
            name,
            line,
            text: text(line),
            skipped: !!skip,
            skipLine: skip ? lineOf(skip) : null,
            skipText: skip ? text(lineOf(skip)) : null,
          });
        }
        // Symfony: #[Route('/x', methods: ['GET'])], under the class's #[Route] prefix.
        const classPrefix = cls
          ? (attributeNames(cls)
              .filter((a) => a.name === "Route")
              .map((a) => phpString(args(a.node)[0] ?? namedArg(a.node, "path")))
              .find((p) => p !== null) ?? "")
          : "";
        for (const a of attrs) {
          if (a.name !== "Route") continue;
          const p = phpString(args(a.node)[0] ?? namedArg(a.node, "path"));
          if (p === null) continue;
          const listed = namedArg(a.node, "methods");
          const methods = listed
            ? listed.namedChildren
                .map((el) => phpString(el?.namedChildren[0])?.toUpperCase())
                .filter((m): m is string => !!m)
            : ["ANY"];
          for (const method of methods)
            facts.routes.push({
              method,
              path: joinPath(classPrefix, p),
              line: lineOf(a.node),
              text: text(lineOf(a.node)),
              handler: name,
            });
        }
        break;
      }
      case "scoped_call_expression":
      case "member_call_expression": {
        const method = node.childForFieldName("name")?.text ?? "";
        const line = lineOf(node.childForFieldName("name") as Node);
        const a = args(node);
        const laravel =
          node.type === "scoped_call_expression" &&
          lastName(node.childForFieldName("scope")?.text ?? "") === "Route";
        // Laravel Route::get('/x', ...), Route::match(['GET'], '/x', ...); Slim/Lumen $app->get('/x', ...)
        let verbs: string[] = [];
        let p: string | null = null;
        let handler: Node | undefined;
        if (HTTP_METHODS.has(method.toLowerCase()) || method === "any") {
          p = phpString(a[0]);
          handler = a[1];
          verbs = [method === "any" ? "ANY" : method.toUpperCase()];
        } else if (method === "match" || method === "map") {
          p = phpString(a[1]);
          handler = a[2];
          verbs = (a[0]?.namedChildren ?? [])
            .map((el) => phpString(el?.namedChildren[0])?.toUpperCase())
            .filter((m): m is string => !!m);
        }
        if (p === null || !verbs.length || a.length < 2) break;
        if (!laravel && (node.type !== "member_call_expression" || !p.startsWith("/"))) break;
        const full = joinPath(groupPrefix(node), routePath(p));
        for (const verb of verbs)
          facts.routes.push({
            method: verb,
            path: full,
            line,
            text: text(line),
            handler: handlerOf(handler),
          });
        break;
      }
      case "function_call_expression": {
        const line = lineOf(node);
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line, text: text(line) });
        const fn = callName(node);
        const a = args(node);
        if (fn === "error_log" || fn === "trigger_error") {
          const msg = phpString(a[0]);
          if (msg?.trim())
            facts.messages.push({ value: msg, line, text: text(line), kind: "console" });
        }
        // Pest: test('…') / it('…'), skipped with ->skip() or ->todo().
        if (inTests && (fn === "test" || fn === "it") && phpString(a[0]) !== null) {
          let skip: Node | null = null;
          for (let o = node.parent; o?.type === "member_call_expression"; o = o.parent)
            if (/^(skip|todo)$/.test(o.childForFieldName("name")?.text ?? "")) skip = o;
          facts.tests.push({
            name: phpString(a[0]) as string,
            line,
            text: text(line),
            skipped: !!skip,
            skipLine: skip ? lineOf(skip.childForFieldName("name") as Node) : null,
            skipText: skip ? text(lineOf(skip.childForFieldName("name") as Node)) : null,
          });
        }
        const tpl = envTemplate(node);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
          facts.urlLiterals.push({ ...tpl, line, template: true, text: text(line) });
        break;
      }
      case "subscript_expression": {
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line: lineOf(node), text: text(lineOf(node)) });
        break;
      }
      case "binary_expression": {
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
      case "object_creation_expression": {
        const type = lastName(node.namedChildren[0]?.text ?? "");
        if (!/(Exception|Error)$/.test(type)) break;
        const msg = phpString(args(node)[0]);
        if (!msg?.trim()) break;
        const line = lineOf(node);
        facts.messages.push({
          value: msg,
          line,
          text: text(line),
          kind: node.parent?.type === "throw_expression" ? "throw" : "error",
        });
        break;
      }
      case "string":
      case "encapsed_string": {
        const v = phpString(node);
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
  return facts;
}
