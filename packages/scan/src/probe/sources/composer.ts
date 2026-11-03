import { refusal, urlProblem } from "./policy.js";

/** The hosts Packagist's public zips come from (ADR 0028, ADR 0029). */
export const COMPOSER_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "codeload.github.com",
  "gitlab.com",
]);

/**
 * composer.lock. Every package's `dist.url` must pass the shared source rule; the download
 * planner (`lockedComposer`) then also requires the URL to be the zip of a locked commit.
 */
export function checkComposerLock(file: string, text: string): string | null {
  let doc: Record<string, { name?: string; dist?: { url?: string } }[] | undefined>;
  try {
    doc = JSON.parse(text);
  } catch {
    return `${file} is not valid JSON`;
  }
  for (const pkg of [...(doc.packages ?? []), ...(doc["packages-dev"] ?? [])]) {
    const url = pkg.dist?.url;
    if (!url) continue;
    const why = urlProblem(url, COMPOSER_HOSTS);
    if (why) return refusal(String(pkg.name ?? "a package"), file, url, why);
  }
  return null;
}
