import { type CheckGroupOutcome, computePulseStatus, type PulseCheckGroup } from "@codesentra/core";
import { detectPlatform } from "./platforms/index.js";
import { checkReachability } from "./reachability.js";
import { Recorder } from "./recorder.js";
import { checkRender } from "./render.js";
import { checkHygiene, checkRoutes, linksFromHtml } from "./routes-hygiene.js";
import type { PlatformIdentity, PulseOptions, PulseResult } from "./types.js";

export const PULSE_GROUPS: readonly PulseCheckGroup[] = [
  "reachability",
  "platform",
  "render",
  "routes",
  "hygiene",
];

/**
 * Runs every Pulse check group against one URL and applies the Section 9 status rule.
 * Pure with respect to storage: the caller persists evidence and findings.
 */
export async function runPulse(opts: PulseOptions): Promise<PulseResult> {
  const started = performance.now();
  const rec = new Recorder();
  const groups = new Map<PulseCheckGroup, CheckGroupOutcome>();
  const done = async (group: PulseCheckGroup) => {
    groups.set(group, { group, ran: true });
    await opts.onGroup?.(group, "done");
  };
  const skip = async (group: PulseCheckGroup, reason: string) => {
    groups.set(group, { group, ran: false, gapReason: reason });
    await opts.onGroup?.(group, "skipped", reason);
  };
  const start = async (group: PulseCheckGroup) => opts.onGroup?.(group, "running");

  await start("reachability");
  const reach = await checkReachability(opts, rec);
  if (!reach.main.reachable && reach.main.failure === "blocked") {
    await skip(
      "reachability",
      "the URL resolves to a non-public address (or is not http/https) and was not contacted",
    );
  } else {
    await done("reachability");
  }

  let platform: PlatformIdentity | null = null;
  const res = reach.response;
  const downReason = !reach.main.reachable
    ? `the main URL did not load (${reach.main.failure})`
    : res && res.status >= 500
      ? `the main URL returned HTTP ${res.status}`
      : null;

  if (!res || downReason) {
    const reason = downReason ?? "the main URL did not load";
    for (const g of PULSE_GROUPS.slice(1)) await skip(g, reason);
  } else {
    await start("platform");
    const finalUrl = new URL(res.url);
    const { adapter, identity } = detectPlatform(finalUrl, res.headers);
    platform = identity;
    const platformKey = rec.addEvidence("platform_identity", res.url, {
      platform: identity.name,
      environment: identity.environment,
      reason: identity.reason,
      expected_environment: opts.expectedEnvironment ?? null,
    });
    const protectedWall = adapter.isAccessProtected(res.status, res.headers, finalUrl);
    if (protectedWall) {
      rec.addFinding(
        "ACCESS_PROTECTED",
        platformKey,
        res.url,
        `The deployment answers with ${identity.name}'s access protection (HTTP ${res.status}); CodeSentra cannot see the app.`,
      );
    } else if (res.status >= 400) {
      const respKey =
        rec.evidence.find((e) => e.kind === "http_response" && e.locator === res.url)?.key ??
        platformKey;
      rec.addFinding("BAD_STATUS", respKey, res.url, `The main URL returned HTTP ${res.status}.`);
    }
    if (opts.expectedEnvironment === "production" && identity.environment === "preview") {
      rec.addFinding(
        "PREVIEW_SERVED_AS_PROD",
        platformKey,
        res.url,
        `The production environment URL serves a ${identity.name} preview deployment (${identity.reason}).`,
      );
    }
    await done("platform");

    if (protectedWall) {
      const reason = `the deployment is behind ${identity.name} access protection; add a bypass token to check it`;
      for (const g of ["render", "routes", "hygiene"] as const) await skip(g, reason);
    } else {
      let links: string[] = linksFromHtml(res.body.toString("utf8"), res.url);
      let screenshot: Buffer | null = null;
      if (opts.browser) {
        await start("render");
        const r = await checkRender(opts.browser, res.url, opts, rec);
        if (r.ran) {
          links = [...new Set([...r.links, ...links])];
          screenshot = r.screenshot;
          await done("render");
        } else {
          await skip("render", r.gapReason ?? "the browser could not render the page");
        }
        rec.screenshot = screenshot;
      } else {
        await skip(
          "render",
          opts.browserUnavailableReason ?? "no browser is available in this environment",
        );
      }

      await start("routes");
      await checkRoutes(res.url, links, opts, rec);
      await done("routes");

      await start("hygiene");
      await checkHygiene(res, opts, rec);
      await done("hygiene");
    }
  }

  const ordered = PULSE_GROUPS.map((g) => groups.get(g) as CheckGroupOutcome);
  const { status, gaps } = computePulseStatus({
    main: reach.main,
    groups: ordered,
    findings: rec.findings,
  });
  return {
    url: opts.url,
    finalUrl: res?.url ?? null,
    status,
    main: reach.main,
    groups: ordered,
    gaps,
    platform,
    evidence: rec.evidence,
    findings: rec.findings,
    screenshot: rec.screenshot,
    durationMs: Math.round(performance.now() - started),
  };
}
