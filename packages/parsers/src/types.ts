/** Languages with a tree-sitter grammar behind the parser interface. */
export type ParserLanguage = "typescript" | "tsx" | "javascript" | "python";

export type MarkerKind = "TODO" | "FIXME" | "HACK" | "XXX";

/** Line numbers are 1-based; `text` is the trimmed source line, for evidence excerpts. */
export interface FileFacts {
  path: string;
  language: ParserLanguage;
  /** `python-member` is `from pkg import name`: a submodule if it resolves, else a symbol. */
  imports: {
    specifier: string;
    line: number;
    kind: "static" | "dynamic" | "require" | "python" | "python-member";
  }[];
  symbols: {
    name: string;
    kind: "function" | "class" | "variable";
    line: number;
    exported: boolean;
  }[];
  /** HTTP routes registered in code (Express/Fastify-style calls, FastAPI/Flask decorators). */
  routes: { method: string; path: string; line: number; text: string; handler: string | null }[];
  envReads: { name: string; line: number; text: string }[];
  /**
   * String literals that look like a URL or `host:port`, and template strings that build a
   * path from interpolations (`${process.env.API}/api/ping`, with the env vars they read).
   */
  urlLiterals: {
    value: string;
    line: number;
    template: boolean;
    envVars: string[];
    text: string;
  }[];
  /** Link targets in markup: JSX/HTML `href="/path"` attribute values. */
  hrefs: { value: string; line: number; text: string }[];
  /**
   * Error message literals: `throw new Error("x")` / `raise X("x")` (throw), `new Error("x")`
   * elsewhere (error) and `console.error("x")` (console). Link joins runtime messages here.
   */
  messages: { value: string; line: number; text: string; kind: "throw" | "error" | "console" }[];
  /** The module's default export (a Next.js page component, for instance). */
  defaultExport: { name: string | null; line: number; text: string } | null;
  /** Test cases. `line` is the test's own line; `skipLine` the line that skips it. */
  tests: {
    name: string;
    line: number;
    text: string;
    skipped: boolean;
    skipLine: number | null;
    skipText: string | null;
  }[];
  markers: { kind: MarkerKind; line: number; text: string }[];
  /** Functions whose only statement throws "not implemented" (or raises NotImplementedError). */
  stubs: { symbol: string | null; line: number; text: string }[];
  cliCommands: { name: string; line: number }[];
  /** Number of syntax error nodes; facts from a file with errors may be incomplete. */
  parseErrors: number;
}

export function emptyFacts(path: string, language: ParserLanguage): FileFacts {
  return {
    path,
    language,
    imports: [],
    symbols: [],
    routes: [],
    envReads: [],
    urlLiterals: [],
    hrefs: [],
    messages: [],
    defaultExport: null,
    tests: [],
    markers: [],
    stubs: [],
    cliCommands: [],
    parseErrors: 0,
  };
}
