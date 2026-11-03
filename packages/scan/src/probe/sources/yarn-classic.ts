import { NPM_HOSTS, refusal, urlProblem } from "./policy.js";

/**
 * yarn.lock written by Yarn 1. Each entry's `resolved` must be a registry tarball (the
 * `#sha1` suffix is Yarn's checksum). Local (`file:`, `link:`) and git entries are refused, and
 * an entry with no `resolved` source at all is refused too.
 */
export function checkYarnClassicLock(file: string, text: string): string | null {
  let head: string | null = null;
  let resolved: string | null = null;
  const close = (): string | null => {
    if (head === null) return null;
    const name = /^"?((?:@[^/@\s"]+\/)?[^@\s"]+)@/.exec(head)?.[1] ?? head;
    if (/@(file|link|portal|exec):|@git\+|@github:/.test(head))
      return refusal(name, file, head, "is not a registry package");
    if (!resolved) return refusal(name, file, head, "names no download source");
    const why = urlProblem(resolved.replace(/#.*$/, ""), NPM_HOSTS);
    return why ? refusal(name, file, resolved, why) : null;
  };
  for (const line of text.split("\n")) {
    if (/^\S/.test(line) && !line.startsWith("#") && line.trimEnd().endsWith(":")) {
      const problem = close();
      if (problem) return problem;
      head = line.trimEnd().slice(0, -1);
      resolved = null;
      continue;
    }
    const r = /^ {2}resolved:? "?([^"\s]+)"?/.exec(line);
    if (r) resolved = r[1] as string;
  }
  return close();
}
