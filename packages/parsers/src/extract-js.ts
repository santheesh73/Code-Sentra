import type { Node, Tree } from "web-tree-sitter";
import { isTestPath } from "./languages.js";
import { emptyFacts, type FileFacts, type ParserLanguage } from "./types.js";
import {
  lineOf,
  lineText,
  looksLikeUrl,
  markersIn,
  NOT_IMPLEMENTED,
  stringValue,
  walk,
} from "./walk.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const TEST_FNS = new Set(["test", "it"]);
const SKIP_FNS = new Set(["xit", "xtest"]);
const SKIP_MODIFIERS = new Set(["skip", "todo"]);
const FUNCTION_NODES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
]);

function firstArg(call: Node): Node | null {
  const args = call.childForFieldName("arguments");
  return args?.namedChildren[0] ?? null;
}

function functionName(fn: Node): string | null {
  const own = fn.childForFieldName("name");
  if (own) return own.text;
  // const exportCsv = () => { ... }
  const parent = fn.parent;
  if (parent?.type === "variable_declarator") return parent.childForFieldName("name")?.text ?? null;
  if (parent?.type === "pair") return parent.childForFieldName("key")?.text ?? null;
  return null;
}

/** `throw new Error("not implemented")` (or a NotImplemented* error class) as a function's only statement. */
function stubThrow(fn: Node): Node | null {
  const body = fn.childForFieldName("body");
  if (body?.type !== "statement_block") return null;
  const stmts = body.namedChildren.filter((c): c is Node => !!c && c.type !== "comment");
  if (stmts.length !== 1 || stmts[0]?.type !== "throw_statement") return null;
  const thrown = stmts[0].namedChildren[0];
  if (!thrown) return null;
  if (thrown.type === "new_expression") {
    const ctor = thrown.childForFieldName("constructor")?.text ?? "";
    if (/NotImplemented/i.test(ctor)) return stmts[0];
    const arg = thrown.childForFieldName("arguments")?.namedChildren[0];
    const msg = arg ? stringValue(arg) : null;
    if (msg && NOT_IMPLEMENTED.test(msg)) return stmts[0];
  }
  return null;
}

/** Env var name for `process.env.X`, `process.env["X"]`, `import.meta.env.X`. */
function envRead(node: Node): string | null {
  if (node.type === "member_expression") {
    const obj = node.childForFieldName("object")?.text;
    if (obj === "process.env" || obj === "import.meta.env") {
      return node.childForFieldName("property")?.text ?? null;
    }
  }
  if (node.type === "subscript_expression") {
    const obj = node.childForFieldName("object")?.text;
    const idx = node.childForFieldName("index");
    if ((obj === "process.env" || obj === "import.meta.env") && idx) return stringValue(idx);
  }
  return null;
}

/** Names of env vars interpolated into a template string (`${process.env.X}`). */
function envVarsIn(node: Node): string[] {
  const out: string[] = [];
  for (const n of walk(node)) {
    const name = envRead(n);
    if (name) out.push(name);
  }
  return out;
}

export function extractJs(
  path: string,
  language: ParserLanguage,
  tree: Tree,
  source: string,
): FileFacts {
  const facts = emptyFacts(path, language);
  const lines = source.split("\n");
  const inTests = isTestPath(path);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "comment":
        facts.markers.push(...markersIn(node));
        break;
      case "import_statement":
      case "export_statement": {
        const src = node.childForFieldName("source");
        const spec = src ? stringValue(src) : null;
        if (spec) facts.imports.push({ specifier: spec, line: lineOf(node), kind: "static" });
        if (node.type === "export_statement") {
          const decl = node.childForFieldName("declaration");
          if (decl) {
            const isClass =
              decl.type === "class_declaration" || decl.type === "abstract_class_declaration";
            const isFn = decl.type.includes("function");
            if (isClass || isFn) {
              const name = decl.childForFieldName("name")?.text;
              if (name)
                facts.symbols.push({
                  name,
                  kind: isClass ? "class" : "function",
                  line: lineOf(decl),
                  exported: true,
                });
            } else if (
              decl.type === "lexical_declaration" ||
              decl.type === "variable_declaration"
            ) {
              for (const d of decl.namedChildren) {
                if (d?.type !== "variable_declarator") continue;
                const name = d.childForFieldName("name")?.text;
                const value = d.childForFieldName("value");
                if (name)
                  facts.symbols.push({
                    name,
                    kind: value && FUNCTION_NODES.has(value.type) ? "function" : "variable",
                    line: lineOf(d),
                    exported: true,
                  });
              }
            }
          }
        }
        break;
      }
      case "function_declaration":
      case "class_declaration":
        if (node.parent?.type !== "export_statement") {
          const name = node.childForFieldName("name")?.text;
          if (name)
            facts.symbols.push({
              name,
              kind: node.type === "class_declaration" ? "class" : "function",
              line: lineOf(node),
              exported: false,
            });
        }
        break;
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (!fn) break;
        const arg = firstArg(node);
        const argValue = arg ? stringValue(arg) : null;
        if (fn.type === "identifier" && fn.text === "require" && argValue) {
          facts.imports.push({ specifier: argValue, line: lineOf(node), kind: "require" });
        } else if (fn.type === "import" && argValue) {
          facts.imports.push({ specifier: argValue, line: lineOf(node), kind: "dynamic" });
        }
        // Tests: test("x"), it("x"), test.skip("x"), it.todo("x"), xit("x").
        if (inTests && argValue !== null) {
          if (fn.type === "identifier" && (TEST_FNS.has(fn.text) || SKIP_FNS.has(fn.text))) {
            const skipped = SKIP_FNS.has(fn.text);
            const line = lineOf(node);
            facts.tests.push({
              name: argValue,
              line,
              text: lineText(lines, line),
              skipped,
              skipLine: skipped ? line : null,
              skipText: skipped ? lineText(lines, line) : null,
            });
          } else if (fn.type === "member_expression") {
            const obj = fn.childForFieldName("object")?.text ?? "";
            const prop = fn.childForFieldName("property")?.text ?? "";
            if (TEST_FNS.has(obj) && (SKIP_MODIFIERS.has(prop) || prop === "only")) {
              const skipped = SKIP_MODIFIERS.has(prop);
              const line = lineOf(node);
              facts.tests.push({
                name: argValue,
                line,
                text: lineText(lines, line),
                skipped,
                skipLine: skipped ? line : null,
                skipText: skipped ? lineText(lines, line) : null,
              });
            }
          }
        }
        if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property")?.text ?? "";
          // Express / Fastify / Koa-router style: router.get("/path", handler).
          if (HTTP_METHODS.has(prop) && argValue?.startsWith("/")) {
            const line = lineOf(node);
            const args = node.childForFieldName("arguments")?.namedChildren ?? [];
            const last = args[args.length - 1];
            facts.routes.push({
              method: prop === "all" ? "ALL" : prop.toUpperCase(),
              path: argValue,
              line,
              text: lineText(lines, line),
              handler: last?.type === "identifier" ? last.text : null,
            });
          }
          // Fastify: app.route({ method: "GET", url: "/x" }).
          if (prop === "route" && arg?.type === "object") {
            let method: string | null = null;
            let url: string | null = null;
            for (const pair of arg.namedChildren) {
              if (pair?.type !== "pair") continue;
              const key = pair.childForFieldName("key")?.text.replace(/["']/g, "");
              const value = pair.childForFieldName("value");
              const v = value ? stringValue(value) : null;
              if (key === "method" && v) method = v.toUpperCase();
              if ((key === "url" || key === "path") && v) url = v;
            }
            if (method && url?.startsWith("/")) {
              const line = lineOf(node);
              facts.routes.push({
                method,
                path: url,
                line,
                text: lineText(lines, line),
                handler: null,
              });
            }
          }
          // commander: program.command("name").
          if (prop === "command" && argValue && /^[a-z][\w:-]*/i.test(argValue)) {
            facts.cliCommands.push({ name: argValue.split(/\s/)[0] as string, line: lineOf(node) });
          }
        }
        break;
      }
      case "member_expression":
      case "subscript_expression": {
        const name = envRead(node);
        if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          const line = lineOf(node);
          facts.envReads.push({ name, line, text: lineText(lines, line) });
        }
        break;
      }
      case "string":
      case "template_string": {
        if (node.parent?.type === "import_statement" || node.parent?.type === "export_statement")
          break;
        const value = stringValue(node);
        if (value !== null) {
          if (looksLikeUrl(value))
            facts.urlLiterals.push({ value, line: lineOf(node), template: false, envVars: [] });
        } else if (node.type === "template_string") {
          // `${process.env.API}/api/ping`: keep the template; Link matches its static suffix.
          const raw = node.text.slice(1, -1);
          if (/\/[\w.-]/.test(raw) || /^https?:/i.test(raw))
            facts.urlLiterals.push({
              value: raw,
              line: lineOf(node),
              template: true,
              envVars: envVarsIn(node),
            });
        }
        break;
      }
      default:
        break;
    }
    if (FUNCTION_NODES.has(node.type)) {
      const t = stubThrow(node);
      if (t) {
        const line = lineOf(t);
        facts.stubs.push({ symbol: functionName(node), line, text: lineText(lines, line) });
      }
    }
  }
  return facts;
}
