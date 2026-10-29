import { posix } from "node:path";
import { NPM_HOSTS, refusal, urlProblem } from "./policy.js";

/** The fields of a one-line flow map (`{integrity: …, tarball: …}`), as pnpm writes them. */
function flowMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.replace(/^\{|\}$/g, "").split(/,\s*/)) {
    const i = part.indexOf(":");
    if (i > 0)
      out[part.slice(0, i).trim()] = part
        .slice(i + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
  }
  return out;
}

/** `link:` targets must stay inside the repository (workspace packages). */
const inside = (importer: string, target: string) => {
  const p = posix.normalize(posix.join(importer === "." ? "" : importer, target));
  return !p.startsWith("/") && p !== ".." && !p.startsWith("../");
};

/**
 * pnpm-lock.yaml, lockfile 5.x, 6.x and 9.x. Registry packages carry only an integrity; a
 * `tarball` must be a registry URL; git repositories, local directories and `file:` tarballs
 * are refused; `link:` is allowed only to a workspace package inside the repository. A
 * resolution of any other shape is refused.
 */
export function checkPnpmLock(file: string, text: string): string | null {
  let section = "";
  let key = "";
  let importer = ".";
  let dep = "";
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      continue;
    }
    const top = /^ {2}(['"]?)([^\s'"].*?)\1:\s*$/.exec(line);
    if (top) {
      key = top[2] as string;
      if (section === "importers") importer = key;
      if (section === "packages" && /(^|@)file:/.test(key))
        return refusal(name(key), file, key, "is a local file, not a registry package");
      continue;
    }
    const depKey = /^ {6}(['"]?)(\S+?)\1:\s*$/.exec(line);
    if (depKey && section === "importers") dep = depKey[2] as string;
    // v9/v6 importers (`version: link:../x`); v5 single projects list them at the top level.
    const version =
      /^\s+version:\s*['"]?(link:|file:)([^'"\s]+)/.exec(line) ??
      (/^(dev|optional)?[dD]ependencies$/.test(section)
        ? /^ {2}\S+:\s*['"]?(link:|file:)([^'"\s]+)/.exec(line)
        : null);
    if (version && section !== "packages") {
      const pkg = section === "importers" ? dep : line.trim().replace(/:.*$/, "");
      const src = `${version[1]}${version[2]}`;
      if (version[1] === "file:")
        return refusal(pkg, file, src, "is a local file, not a registry package");
      if (!inside(importer, version[2] as string))
        return refusal(pkg, file, src, "is outside the workspace");
      continue;
    }
    const res = /^\s+resolution:\s*(\{.*\})\s*$/.exec(line);
    if (!res || section !== "packages") continue;
    const r = flowMap(res[1] as string);
    const pkg = name(key);
    if (r.tarball) {
      const why = urlProblem(r.tarball, NPM_HOSTS);
      if (why) return refusal(pkg, file, r.tarball, why);
    } else if (r.type === "git" || r.repo) {
      return refusal(pkg, file, r.repo ?? key, "is a git repository, not a registry package");
    } else if (r.type === "directory" || r.directory) {
      return refusal(pkg, file, r.directory ?? key, "is a local directory, not a registry package");
    } else if (!r.integrity || Object.keys(r).some((k) => k !== "integrity")) {
      return refusal(pkg, file, res[1] as string, "is a resolution this check does not recognise");
    }
  }
  return null;
}

/** The package name in a key: `/is-number/7.0.0`, `/@a/b@1.0.0`, `is-number@7.0.0(peer@1)`. */
function name(key: string): string {
  const k = key.replace(/^\//, "");
  const at = k.indexOf("@", k.startsWith("@") ? 1 : 0);
  if (at > 0) return k.slice(0, at);
  const parts = k.split("/");
  return k.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}
