import { extractJs } from "./extract-js.js";
import { extractPy } from "./extract-py.js";
import { parserLanguageFor } from "./languages.js";
import { parserFor } from "./loader.js";
import type { FileFacts, ParserLanguage } from "./types.js";

export { detectLanguage, isTestPath, PARSED_LANGUAGES, parserLanguageFor } from "./languages.js";
export type { EmbeddedWasm } from "./loader.js";
export { useEmbeddedWasm } from "./loader.js";
export type { FileFacts, MarkerKind, ParserLanguage } from "./types.js";

/** Files above this size are not parsed (generated bundles, minified code); listed as a gap. */
export const MAX_PARSE_BYTES = 1024 * 1024;

/**
 * Parses one file with tree-sitter and extracts deterministic facts: imports, symbols,
 * routes, env var reads, URL literals, tests, markers and stubs. Never executes code.
 * Returns null when the file's language has no parser.
 */
export async function parseFile(
  path: string,
  source: string,
  language: ParserLanguage | null = parserLanguageFor(path, source.slice(0, 200).split("\n")[0]),
): Promise<FileFacts | null> {
  if (!language) return null;
  const parser = await parserFor(language);
  try {
    const tree = parser.parse(source);
    if (!tree) return null;
    try {
      return language === "python"
        ? extractPy(path, tree, source)
        : extractJs(path, language, tree, source);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
