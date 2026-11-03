import { checkComposerLock } from "./composer.js";
import { checkNpmLock } from "./npm.js";
import { checkPnpmLock } from "./pnpm.js";
import { checkPoetryLock } from "./poetry.js";
import { checkYarnBerryLock } from "./yarn-berry.js";
import { checkYarnClassicLock } from "./yarn-classic.js";

export { COMPOSER_HOSTS } from "./composer.js";
export { NPM_HOSTS, PYPI_HOSTS, urlProblem } from "./policy.js";

/** The lockfile each package manager downloads from, at the project root. */
export const LOCKFILES_BY_MANAGER: Readonly<Record<string, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  composer: ["composer.lock"],
};

/** Whether a yarn.lock was written by Yarn 2+ (Berry), which keeps a `__metadata` block. */
export const isBerryLock = (text: string) => /^__metadata:\s*$/m.test(text);

/**
 * Checks every download source a lockfile names (ADR 0030). Returns why the download is
 * refused (naming the dependency), or null when every source is an allowed registry.
 */
export function checkLockSources(file: string, text: string): string | null {
  const base = file.slice(file.lastIndexOf("/") + 1);
  switch (base) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return checkNpmLock(file, text);
    case "pnpm-lock.yaml":
      return checkPnpmLock(file, text);
    case "yarn.lock":
      return isBerryLock(text) ? checkYarnBerryLock(file, text) : checkYarnClassicLock(file, text);
    case "poetry.lock":
      return checkPoetryLock(file, text);
    case "composer.lock":
      return checkComposerLock(file, text);
    default:
      return `${file} is not a lockfile this check reads`;
  }
}
