import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import type { ParserLanguage } from "./types.js";

const require = createRequire(import.meta.url);

const WASM: Record<ParserLanguage, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
};

let init: Promise<void> | null = null;
const languages = new Map<ParserLanguage, Promise<Language>>();

/** Loads (once) and returns a parser for the language. Parsers are cheap; languages are cached. */
export async function parserFor(language: ParserLanguage): Promise<Parser> {
  init ??= Parser.init({
    locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
  });
  await init;
  let lang = languages.get(language);
  if (!lang) {
    lang = Language.load(require.resolve(WASM[language]));
    languages.set(language, lang);
  }
  const parser = new Parser();
  parser.setLanguage(await lang);
  return parser;
}
