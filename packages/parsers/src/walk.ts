import type { Node } from "web-tree-sitter";
import type { MarkerKind } from "./types.js";

/** Depth-first, iterative (deeply nested ASTs must not overflow the stack). */
export function* walk(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop() as Node;
    yield node;
    const kids = node.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k) stack.push(k);
    }
  }
}

export const lineOf = (n: Node) => n.startPosition.row + 1;

export function lineText(lines: string[], line: number): string {
  return (lines[line - 1] ?? "").trim().slice(0, 300);
}

const MARKER = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)$/;

/** TODO/FIXME/HACK/XXX markers inside one comment node, one per marked line. */
export function markersIn(comment: Node): { kind: MarkerKind; line: number; text: string }[] {
  const out: { kind: MarkerKind; line: number; text: string }[] = [];
  const rows = comment.text.split("\n");
  rows.forEach((row, i) => {
    const m = MARKER.exec(row);
    if (m) {
      const text = row
        .replace(/^\s*(\/\/+|\/\*+|\*+|#+)\s?/, "")
        .replace(/\*+\/\s*$/, "")
        .trim();
      out.push({ kind: m[1] as MarkerKind, line: lineOf(comment) + i, text });
    }
  });
  return out;
}

const URL_LIKE =
  /^(https?:\/\/[^\s"'`<>]+|(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}(?:\/[^\s"'`<>]*)?)$/i;

export function looksLikeUrl(value: string): boolean {
  return value.length <= 2048 && URL_LIKE.test(value);
}

export const NOT_IMPLEMENTED = /not\s*(yet\s*)?implemented|unimplemented/i;

/** Unquotes a JS/Python string literal's text when it has no interpolation. */
export function stringValue(node: Node): string | null {
  if (node.type === "string") {
    const frags = node.namedChildren.filter(
      (c): c is Node => !!c && (c.type === "string_fragment" || c.type === "string_content"),
    );
    if (node.namedChildren.some((c) => c?.type === "interpolation")) return null;
    return frags.map((f) => f.text).join("");
  }
  if (node.type === "template_string") {
    if (node.namedChildren.some((c) => c?.type === "template_substitution")) return null;
    return node.text.slice(1, -1);
  }
  return null;
}
