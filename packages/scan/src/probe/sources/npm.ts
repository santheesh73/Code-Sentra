import { NPM_HOSTS, refusal, urlProblem } from "./policy.js";

type Entry = { version?: string; resolved?: string; link?: boolean; dependencies?: Deps };
type Deps = Record<string, Entry>;

/**
 * package-lock.json / npm-shrinkwrap.json (lockfile v1–v3). Workspace links (`link: true`)
 * are local and fetch nothing; every other entry with a `resolved` source must be a registry
 * tarball.
 */
export function checkNpmLock(file: string, text: string): string | null {
  let data: { packages?: Deps; dependencies?: Deps };
  try {
    data = JSON.parse(text);
  } catch {
    return `${file} is not valid JSON`;
  }
  const entries: [string, Entry][] = [];
  if (data.packages) {
    for (const [key, e] of Object.entries(data.packages)) {
      if (!key || e.link) continue;
      entries.push([key.slice(key.lastIndexOf("node_modules/") + 13) || key, e]);
    }
  } else {
    const walk = (deps: Deps) => {
      for (const [name, e] of Object.entries(deps)) {
        entries.push([name, e]);
        if (e.dependencies) walk(e.dependencies);
      }
    };
    walk(data.dependencies ?? {});
  }
  for (const [name, e] of entries) {
    // Lockfile v1 keeps git and URL sources in `version` (`git+ssh://…#sha`, `github:a/b`).
    const source = e.resolved ?? (/[:/]/.test(e.version ?? "") ? e.version : undefined);
    if (!source) continue;
    const why = urlProblem(source, NPM_HOSTS);
    if (why) return refusal(name, file, source, why);
  }
  return null;
}
