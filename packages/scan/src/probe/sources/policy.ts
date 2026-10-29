import { checkAddress, isIpLiteral } from "@codesentra/ssrf";

/**
 * The one rule every lockfile source must pass (ADR 0030): HTTPS, on the default port, with no
 * credentials, on a host from the ecosystem's registry allowlist. IP literals are refused
 * outright, and the SSRF address check explains private ones.
 */
export const NPM_HOSTS: ReadonlySet<string> = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
]);
export const PYPI_HOSTS: ReadonlySet<string> = new Set(["pypi.org", "files.pythonhosted.org"]);

/** Why `raw` is not an allowed registry URL, or null when it is. */
export function urlProblem(raw: string, hosts: ReadonlySet<string>): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a registry URL";
  }
  if (u.protocol !== "https:") return `uses ${u.protocol}, not https:`;
  if (u.username || u.password) return "carries credentials";
  if (u.port) return `uses port ${u.port}`;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) {
    const v = checkAddress(host);
    return `is an IP address${v.allowed ? "" : ` (${v.reason})`}, not a registry`;
  }
  if (!hosts.has(host)) return `is on ${host}, which is not an allowed registry`;
  return null;
}

/** The refusal text for one dependency. */
export const refusal = (name: string, file: string, source: string, why: string) =>
  `${name} in ${file}: its source ${source.slice(0, 120)} ${why}`;
