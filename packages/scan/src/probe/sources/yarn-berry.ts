import { posix } from "node:path";
import { refusal } from "./policy.js";

/** The `<name>@` prefix of a Berry descriptor (`@scope/name@npm:1.0.0`). */
const nameOf = (d: string) => /^((?:@[^/@]+\/)?[^@]+)@/.exec(d)?.[1] ?? d;

/**
 * Whether a Berry resolution fetches only from the registry: `npm:` versions, workspaces
 * inside the repository, and `patch:` of an npm package with Yarn's built-in patches only
 * (`~builtin<compat/…>`, which ship inside Yarn). A patch file from the repository is refused
 * like every other local or remote source (ADR 0030).
 */
function allowed(resolution: string): boolean {
  const at = resolution.indexOf("@", resolution.startsWith("@") ? 1 : 0);
  const spec = resolution.slice(at + 1);
  if (/^npm:[^:/]+$/.test(spec)) return true;
  if (spec.startsWith("workspace:")) {
    const p = posix.normalize(spec.slice("workspace:".length));
    return !p.startsWith("/") && p !== ".." && !p.startsWith("../");
  }
  const patch = /^patch:(.+?)#(.+)$/.exec(spec);
  if (!patch) return false;
  const inner = decodeURIComponent(patch[1] as string);
  const sources = (patch[2] as string).replace(/::.*$/, "").split("&");
  return (
    allowed(inner) &&
    inner.includes("@npm:") &&
    sources.every((s) => /^(optional!)?(~)?builtin<compat\/[\w-]+>$/.test(s))
  );
}

/** yarn.lock written by Yarn 2+ (it has a `__metadata` block). */
export function checkYarnBerryLock(file: string, text: string): string | null {
  for (const m of text.matchAll(/^ {2}resolution: "?([^"\n]+)"?$/gm)) {
    const r = m[1] as string;
    if (!allowed(r)) return refusal(nameOf(r), file, r, "is not a registry package");
  }
  return null;
}
