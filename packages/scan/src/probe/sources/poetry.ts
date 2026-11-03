import { PYPI_HOSTS, refusal, urlProblem } from "./policy.js";

/**
 * poetry.lock. A package with no `[package.source]` comes from PyPI. A source block is
 * allowed only when it is a package index on PyPI's own hosts; git, URL, file and directory
 * sources, and any other index, are refused.
 */
export function checkPoetryLock(file: string, text: string): string | null {
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? "a package";
    const source = /^\[package\.source\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(block)?.[1];
    if (!source) continue;
    const type = /^type\s*=\s*"([^"]*)"/m.exec(source)?.[1] ?? "";
    const url = /^url\s*=\s*"([^"]*)"/m.exec(source)?.[1] ?? "";
    if (type !== "legacy")
      return refusal(name, file, `${type} ${url}`.trim(), "is not a package index");
    const why = urlProblem(url, PYPI_HOSTS);
    if (why) return refusal(name, file, url, why);
  }
  return null;
}
