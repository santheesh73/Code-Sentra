import type { Node, Tree } from "web-tree-sitter";
import { isTestPath } from "./languages.js";
import { emptyFacts, type FileFacts } from "./types.js";
import {
  lineOf,
  lineText,
  looksLikeUrl,
  markersIn,
  NOT_IMPLEMENTED,
  stringValue,
  walk,
} from "./walk.js";

const ROUTE_ATTRS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "route",
  "api_route",
]);
const SKIP_DECORATOR = /^@(pytest\.mark\.(skip|skipif|xfail)|unittest\.skip\w*)\b/;

function callArgs(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((c): c is Node => !!c);
}

function keywordArg(call: Node, name: string): Node | null {
  for (const a of callArgs(call)) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === name)
      return a.childForFieldName("value");
  }
  return null;
}

/** `os.getenv("X")`, `os.environ.get("X")`, `environ.get("X")`. */
function envCall(call: Node): string | null {
  const fn = call.childForFieldName("function")?.text ?? "";
  if (!/^(os\.getenv|getenv|os\.environ\.get|environ\.get)$/.test(fn)) return null;
  const first = callArgs(call)[0];
  return first ? stringValue(first) : null;
}

/** A function whose body (after an optional docstring) only raises NotImplementedError. */
function stubRaise(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  if (!body) return null;
  const stmts = body.namedChildren.filter((c): c is Node => !!c && c.type !== "comment");
  const rest =
    stmts[0]?.type === "expression_statement" && stmts[0].namedChildren[0]?.type === "string"
      ? stmts.slice(1)
      : stmts;
  if (rest.length !== 1 || rest[0]?.type !== "raise_statement") return null;
  const raised = rest[0].namedChildren[0];
  if (!raised) return null;
  const name =
    raised.type === "call" ? (raised.childForFieldName("function")?.text ?? "") : raised.text;
  if (name === "NotImplementedError") return rest[0];
  if (raised.type === "call") {
    const msg = callArgs(raised)[0];
    const v = msg ? stringValue(msg) : null;
    if (v && NOT_IMPLEMENTED.test(v)) return rest[0];
  }
  return null;
}

export function extractPy(path: string, tree: Tree, source: string): FileFacts {
  const facts = emptyFacts(path, "python");
  const lines = source.split("\n");
  const inTests = isTestPath(path);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "comment":
        facts.markers.push(...markersIn(node));
        break;
      case "import_statement":
        for (const n of node.namedChildren) {
          const name = n?.type === "aliased_import" ? n.childForFieldName("name") : n;
          if (name?.type === "dotted_name")
            facts.imports.push({ specifier: name.text, line: lineOf(node), kind: "python" });
        }
        break;
      case "import_from_statement": {
        const mod = node.childForFieldName("module_name");
        if (!mod) break;
        facts.imports.push({ specifier: mod.text, line: lineOf(node), kind: "python" });
        // `from pkg import sub` may name a submodule; the graph keeps it only if it resolves.
        const sep = mod.text.endsWith(".") ? "" : ".";
        for (const n of node.childrenForFieldName("name")) {
          const name = n?.type === "aliased_import" ? n.childForFieldName("name") : n;
          if (name?.type === "dotted_name")
            facts.imports.push({
              specifier: `${mod.text}${sep}${name.text}`,
              line: lineOf(node),
              kind: "python-member",
            });
        }
        break;
      }
      case "function_definition":
      case "class_definition": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const topLevel =
          node.parent?.type === "module" ||
          (node.parent?.type === "decorated_definition" && node.parent.parent?.type === "module");
        if (topLevel)
          facts.symbols.push({
            name,
            kind: node.type === "class_definition" ? "class" : "function",
            line: lineOf(node),
            exported: !name.startsWith("_"),
          });
        if (node.type === "function_definition") {
          const t = stubRaise(node);
          if (t) {
            const line = lineOf(t);
            facts.stubs.push({ symbol: name, line, text: lineText(lines, line) });
          }
          if (inTests && name.startsWith("test")) {
            const decorators =
              node.parent?.type === "decorated_definition"
                ? node.parent.namedChildren.filter((c): c is Node => c?.type === "decorator")
                : [];
            const skip = decorators.find((d) => SKIP_DECORATOR.test(d.text));
            const line = lineOf(node);
            facts.tests.push({
              name,
              line,
              text: lineText(lines, line),
              skipped: !!skip,
              skipLine: skip ? lineOf(skip) : null,
              skipText: skip ? lineText(lines, lineOf(skip)) : null,
            });
          }
        }
        break;
      }
      case "decorator": {
        // @app.get("/x"), @router.post("/x"), @app.route("/x", methods=["POST"]).
        const call = node.namedChildren[0];
        if (call?.type !== "call") break;
        const fn = call.childForFieldName("function");
        if (fn?.type !== "attribute") break;
        const attr = fn.childForFieldName("attribute")?.text ?? "";
        if (!ROUTE_ATTRS.has(attr)) break;
        const first = callArgs(call)[0];
        const path = first ? stringValue(first) : null;
        if (!path?.startsWith("/")) break;
        let methods = [attr.toUpperCase()];
        if (attr === "route" || attr === "api_route") {
          const m = keywordArg(call, "methods");
          const listed = m?.namedChildren
            .map((c) => (c ? stringValue(c) : null))
            .filter((v): v is string => !!v);
          methods = listed?.length ? listed.map((v) => v.toUpperCase()) : ["GET"];
        }
        const def = node.parent?.childForFieldName("definition");
        const line = lineOf(node);
        for (const method of methods)
          facts.routes.push({
            method,
            path,
            line,
            text: lineText(lines, line),
            handler: def?.childForFieldName("name")?.text ?? null,
          });
        break;
      }
      case "call": {
        const env = envCall(node);
        if (env) {
          const line = lineOf(node);
          facts.envReads.push({ name: env, line, text: lineText(lines, line) });
        }
        const fn = node.childForFieldName("function");
        // argparse: subparsers.add_parser("name").
        if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "add_parser") {
          const first = callArgs(node)[0];
          const v = first ? stringValue(first) : null;
          if (v) facts.cliCommands.push({ name: v, line: lineOf(node) });
        }
        break;
      }
      case "subscript": {
        // os.environ["X"]
        const value = node.childForFieldName("value")?.text;
        const sub = node.childForFieldName("subscript");
        if ((value === "os.environ" || value === "environ") && sub) {
          const name = stringValue(sub);
          if (name) {
            const line = lineOf(node);
            facts.envReads.push({ name, line, text: lineText(lines, line) });
          }
        }
        break;
      }
      case "string": {
        const v = stringValue(node);
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
      case "raise_statement": {
        // raise ValueError("x"): the message a traceback shows.
        const call = node.namedChildren[0];
        const arg =
          call?.type === "call" ? call.childForFieldName("arguments")?.namedChildren[0] : null;
        const msg = arg ? stringValue(arg) : null;
        if (msg?.trim()) {
          const line = lineOf(node);
          facts.messages.push({ value: msg, line, text: lineText(lines, line), kind: "throw" });
        }
        break;
      }
      default:
        break;
    }
  }
  return facts;
}
