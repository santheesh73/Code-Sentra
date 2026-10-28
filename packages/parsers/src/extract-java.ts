import type { Node, Tree } from "web-tree-sitter";
import { emptyFacts, type FileFacts } from "./types.js";
import { lineOf, lineText, looksLikeUrl, markersIn, NOT_IMPLEMENTED, walk } from "./walk.js";

/** Spring's per-method mappings; `RequestMapping` reads its `method` attribute. */
const SPRING_MAPPINGS: Record<string, string | null> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
  RequestMapping: null,
};
const JAXRS_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const TEST_ANNOTATIONS = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "TestTemplate",
]);
const SKIP_ANNOTATIONS = new Set(["Disabled", "Ignore"]);
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

/** The value of a Java string literal (or text block), or null for anything else. */
export function javaString(node: Node | null | undefined): string | null {
  if (node?.type !== "string_literal") return null;
  return node.namedChildren
    .map((c) => {
      if (!c) return "";
      if (c.type === "escape_sequence") return ESCAPES[c.text.slice(1)] ?? c.text;
      return c.text;
    })
    .join("");
}

const args = (n: Node) =>
  (n.childForFieldName("arguments")?.namedChildren ?? []).filter((c): c is Node => !!c);

/** Annotations on a declaration, by simple name (`org.x.GetMapping` → `GetMapping`). */
function annotationsOf(decl: Node): Node[] {
  const mods = decl.namedChildren.find((c) => c?.type === "modifiers");
  return (mods?.namedChildren ?? []).filter(
    (c): c is Node => !!c && (c.type === "annotation" || c.type === "marker_annotation"),
  );
}
const annotationName = (a: Node) => a.childForFieldName("name")?.text.split(".").pop() ?? "";
const isPublic = (decl: Node) =>
  /\bpublic\b/.test(decl.namedChildren.find((c) => c?.type === "modifiers")?.text ?? "");

/** An annotation attribute's values: the positional value, or `value =`/`path =`, as strings. */
function annotationValues(a: Node, keys: string[]): Node[] {
  const list = a.childForFieldName("arguments");
  const out: Node[] = [];
  for (const c of list?.namedChildren ?? []) {
    if (!c) continue;
    if (c.type === "element_value_pair") {
      if (!keys.includes(c.childForFieldName("key")?.text ?? "")) continue;
      const v = c.childForFieldName("value");
      if (v?.type === "element_value_array_initializer")
        out.push(...v.namedChildren.filter((x): x is Node => !!x));
      else if (v) out.push(v);
    } else if (keys.includes("value")) {
      if (c.type === "element_value_array_initializer")
        out.push(...c.namedChildren.filter((x): x is Node => !!x));
      else out.push(c);
    }
  }
  return out;
}

const pathsOf = (a: Node) =>
  annotationValues(a, ["value", "path"])
    .map(javaString)
    .filter((v): v is string => v !== null);

const joinPath = (prefix: string, p: string) =>
  `/${[prefix, p]
    .map((x) => x.replace(/^\/|\/$/g, ""))
    .filter(Boolean)
    .join("/")}`;

/** `System.getenv("X")`: the env var name. */
function envName(node: Node): string | null {
  if (node.type !== "method_invocation") return null;
  if (node.childForFieldName("object")?.text !== "System") return null;
  if (node.childForFieldName("name")?.text !== "getenv") return null;
  return javaString(args(node)[0]);
}

/** `System.getenv("API") + "/api/ping"` or `String.format("%s/api", System.getenv("API"))`. */
function envTemplate(node: Node): { value: string; envVars: string[] } | null {
  const envVars: string[] = [];
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    if (node.parent?.type === "binary_expression") return null;
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
    let value = "";
    for (const p of parts) {
      const env = envName(p);
      const lit = javaString(p);
      if (env) {
        envVars.push(env);
        value += `\${${p.text}}`;
      } else if (lit !== null) value += lit;
      else return null;
    }
    return envVars.length ? { value, envVars } : null;
  }
  if (
    node.type === "method_invocation" &&
    node.childForFieldName("object")?.text === "String" &&
    node.childForFieldName("name")?.text === "format"
  ) {
    const [fmt, ...rest] = args(node);
    const format = javaString(fmt);
    if (format === null) return null;
    let i = 0;
    let ok = true;
    const value = format.replace(/%[-+# 0-9.,(]*[a-zA-Z%]/g, (verb) => {
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

/** `throw new UnsupportedOperationException()` (or "not implemented") as a body's only statement. */
function stubOf(method: Node): Node | null {
  const body = method.childForFieldName("body");
  const stmts = (body?.namedChildren ?? []).filter(
    (c): c is Node => !!c && c.type !== "line_comment" && c.type !== "block_comment",
  );
  if (stmts.length !== 1 || stmts[0]?.type !== "throw_statement") return null;
  const created = stmts[0].namedChildren[0];
  if (created?.type !== "object_creation_expression") return null;
  const type = created.childForFieldName("type")?.text ?? "";
  const msg = javaString(args(created)[0]);
  if (/NotImplemented/.test(type)) return stmts[0];
  if (type === "UnsupportedOperationException" && (msg === null || NOT_IMPLEMENTED.test(msg)))
    return stmts[0];
  if (msg && NOT_IMPLEMENTED.test(msg)) return stmts[0];
  return null;
}

export function extractJava(path: string, tree: Tree, source: string): FileFacts {
  const facts = emptyFacts(path, "java");
  const lines = source.split("\n");
  const text = (line: number) => lineText(lines, line);

  for (const node of walk(tree.rootNode)) {
    if (node.type === "ERROR" || node.isMissing) facts.parseErrors++;
    switch (node.type) {
      case "line_comment":
      case "block_comment":
        facts.markers.push(...markersIn(node));
        break;
      case "import_declaration": {
        const id = node.namedChildren.find(
          (c) => c?.type === "scoped_identifier" || c?.type === "identifier",
        );
        if (!id) break;
        const wildcard = node.namedChildren.some((c) => c?.type === "asterisk");
        const isStatic = node.children.some((c) => c?.type === "static");
        // `import static a.b.C.member;` imports from the type a.b.C.
        const spec = isStatic && !wildcard ? id.text.replace(/\.[^.]+$/, "") : id.text;
        facts.imports.push({
          specifier: spec,
          line: lineOf(node),
          kind: wildcard && !isStatic ? "java-wildcard" : "java",
        });
        break;
      }
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "record_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode)
          facts.symbols.push({
            name: nameNode.text,
            kind: "class",
            line: lineOf(nameNode),
            exported: isPublic(node),
          });
        break;
      }
      case "method_declaration": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text;
        if (!name || !nameNode) break;
        // The declaration starts at its annotations; the method is where its name is.
        const line = lineOf(nameNode);
        const cls = node.parent?.parent;
        if (cls && /_declaration$/.test(cls.type) && cls.parent?.type === "program")
          facts.symbols.push({ name, kind: "function", line, exported: isPublic(node) });
        const stub = stubOf(node);
        if (stub) facts.stubs.push({ symbol: name, line: lineOf(stub), text: text(lineOf(stub)) });

        const anns = annotationsOf(node);
        const classAnns = cls ? annotationsOf(cls) : [];
        // JUnit cases are annotated, wherever the file lives.
        if (anns.some((a) => TEST_ANNOTATIONS.has(annotationName(a)))) {
          const skip =
            anns.find((a) => SKIP_ANNOTATIONS.has(annotationName(a))) ??
            classAnns.find((a) => SKIP_ANNOTATIONS.has(annotationName(a))) ??
            null;
          facts.tests.push({
            name,
            line,
            text: text(line),
            skipped: !!skip,
            skipLine: skip ? lineOf(skip) : null,
            skipText: skip ? text(lineOf(skip)) : null,
          });
        }

        // Spring: class-level @RequestMapping prefix + method mapping. JAX-RS: @Path + @GET.
        const springPrefix =
          classAnns.filter((a) => annotationName(a) === "RequestMapping").flatMap(pathsOf)[0] ?? "";
        const jaxPrefix =
          classAnns.filter((a) => annotationName(a) === "Path").flatMap(pathsOf)[0] ?? "";
        for (const a of anns) {
          const an = annotationName(a);
          if (an in SPRING_MAPPINGS) {
            let methods = SPRING_MAPPINGS[an] ? [SPRING_MAPPINGS[an] as string] : [];
            if (!methods.length)
              methods = annotationValues(a, ["method"])
                .map((v) => v.text.split(".").pop() ?? "")
                .filter((m) => JAXRS_METHODS.has(m));
            if (!methods.length) methods = ["ANY"];
            const ps = pathsOf(a);
            for (const p of ps.length ? ps : [""])
              for (const method of methods)
                facts.routes.push({
                  method,
                  path: joinPath(springPrefix, p),
                  line: lineOf(a),
                  text: text(lineOf(a)),
                  handler: name,
                });
          }
          if (JAXRS_METHODS.has(an) && a.type === "marker_annotation") {
            const sub = anns.filter((x) => annotationName(x) === "Path").flatMap(pathsOf)[0] ?? "";
            if (jaxPrefix || sub)
              facts.routes.push({
                method: an,
                path: joinPath(jaxPrefix, sub),
                line: lineOf(a),
                text: text(lineOf(a)),
                handler: name,
              });
          }
        }
        break;
      }
      case "method_invocation": {
        const line = lineOf(node);
        const env = envName(node);
        if (env) facts.envReads.push({ name: env, line, text: text(line) });
        const tpl = envTemplate(node);
        if (tpl && (/\/[\w.-]/.test(tpl.value) || /^https?:/i.test(tpl.value)))
          facts.urlLiterals.push({ ...tpl, line, template: true, text: text(line) });
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
        const type = node.childForFieldName("type")?.text ?? "";
        if (!/(Exception|Error)$/.test(type)) break;
        const msg = javaString(args(node)[0]);
        if (!msg?.trim()) break;
        const line = lineOf(node);
        facts.messages.push({
          value: msg,
          line,
          text: text(line),
          kind: node.parent?.type === "throw_statement" ? "throw" : "error",
        });
        break;
      }
      case "string_literal": {
        if (
          node.parent?.type === "annotation_argument_list" ||
          node.parent?.type === "element_value_pair"
        )
          break;
        const v = javaString(node);
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
