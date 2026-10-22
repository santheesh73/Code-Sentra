import type { ParserLanguage } from "./types.js";

/** Display names for every language we can recognize, parsed or not (for coverage gaps). */
const BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".pyi": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".swift": "Swift",
  ".scala": "Scala",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".lua": "Lua",
  ".sh": "Shell",
  ".bash": "Shell",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

const SHEBANG: [RegExp, string][] = [
  [/^#!.*\bpython[0-9.]*\b/, "Python"],
  [/^#!.*\b(node|deno|bun)\b/, "JavaScript"],
  [/^#!.*\b(ba|z)?sh\b/, "Shell"],
];

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.endsWith(".d.ts")) return ".d.ts";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The language a file is written in, by extension, else by shebang; null if unknown. */
export function detectLanguage(path: string, firstLine = ""): string | null {
  const ext = extensionOf(path);
  if (ext === ".d.ts") return "TypeScript";
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext] as string;
  if (!ext && firstLine.startsWith("#!")) {
    for (const [re, name] of SHEBANG) if (re.test(firstLine)) return name;
  }
  return null;
}

/** The grammar that parses a file, or null when its language has no parser yet. */
export function parserLanguageFor(path: string, firstLine = ""): ParserLanguage | null {
  const ext = extensionOf(path);
  if (ext === ".tsx") return "tsx";
  if ([".ts", ".mts", ".cts", ".d.ts"].includes(ext)) return "typescript";
  if (ext === ".jsx") return "tsx";
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if ([".py", ".pyi"].includes(ext)) return "python";
  const lang = detectLanguage(path, firstLine);
  if (lang === "Python") return "python";
  if (lang === "JavaScript") return "javascript";
  return null;
}

/** Languages that have a parser, by display name. */
export const PARSED_LANGUAGES = new Set(["TypeScript", "JavaScript", "Python"]);

const TEST_PATH =
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
