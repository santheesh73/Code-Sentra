import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import type { ParserLanguage } from "./types.js";

const require = createRequire(import.meta.url);

const WASM: Record<ParserLanguage, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  ruby: "tree-sitter-ruby/tree-sitter-ruby.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  php: "tree-sitter-php/tree-sitter-php.wasm",
};

let init: Promise<void> | null = null;
const languages = new Map<ParserLanguage, Promise<Language>>();
let embedded: EmbeddedWasm | null = null;

/** The grammars as bytes, for builds that ship no node_modules (the single-file CLI). */
export interface EmbeddedWasm {
  runtime: Uint8Array;
  languages: Record<ParserLanguage, Uint8Array>;
}

/** Makes parserFor load grammars from these bytes instead of resolving the wasm packages. */
export function useEmbeddedWasm(wasm: EmbeddedWasm): void {
  if (init) throw new Error("useEmbeddedWasm must be called before the first parse");
  embedded = wasm;
}

/** Loads (once) and returns a parser for the language. Parsers are cheap; languages are cached. */
export async function parserFor(language: ParserLanguage): Promise<Parser> {
  init ??= Parser.init(
    embedded
      ? { wasmBinary: embedded.runtime.slice().buffer }
      : { locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm") },
  );
  await init;
  let lang = languages.get(language);
  if (!lang) {
    lang = Language.load(embedded ? embedded.languages[language] : require.resolve(WASM[language]));
    languages.set(language, lang);
  }
  const parser = new Parser();
  parser.setLanguage(await lang);
  return parser;
}
