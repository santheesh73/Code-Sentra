import { existsSync } from "node:fs";
import type { Browser } from "playwright-core";

/** CHROMIUM_EXECUTABLE, else the preinstalled /opt/pw-browsers/chromium, else Playwright's own install. */
export function chromiumExecutable(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.CHROMIUM_EXECUTABLE) return env.CHROMIUM_EXECUTABLE;
  return existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}

/**
 * Launches headless Chromium for the render check. Returns the reason instead of
 * throwing so callers can record a gap (Rule 2) rather than fail the whole run.
 */
export async function launchPulseBrowser(): Promise<
  { browser: Browser } | { browser: null; reason: string }
> {
  try {
    const { chromium } = await import("playwright-core");
    const executablePath = chromiumExecutable();
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--disable-dev-shm-usage"],
    });
    return { browser };
  } catch (e) {
    return {
      browser: null,
      reason: `Chromium could not start: ${(e as Error).message.split("\n")[0]}`,
    };
  }
}
