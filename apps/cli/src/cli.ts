import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  draftIssues,
  type IssueDraftOut,
  launchPulseBrowser,
  type PulseResult,
  runPulse,
} from "@codesentra/checks";
import type { PulseStatus } from "@codesentra/core";
import { defaultPolicy, type FetchPolicy, testPolicy } from "@codesentra/ssrf";
import type { Browser } from "playwright-core";

/** Section 15 exit codes. `unverified` is never 0: a skipped check is not a pass (Rule 2). */
export const EXIT: Record<PulseStatus | "usage", number> = {
  live: 0,
  degraded: 1,
  unverified: 1,
  down: 2,
  usage: 3,
};

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  launchBrowser(): Promise<{ browser: Browser } | { browser: null; reason: string }>;
  /** Overrides the fetch policy built from the environment (tests). */
  policy?: FetchPolicy;
}

const USAGE = `Usage:
  codesentra pulse <url> [--json] [--fix-prompt] [--timeout=<ms>]

Checks a deployed URL in-process: reachability, TLS, platform, browser render,
linked routes and headers. No account needed.

Options:
  --json          Print the result as JSON (includes every prompt)
  --fix-prompt    Print each issue's fix prompt
  --timeout=<ms>  Per-request timeout (default 15000)
  -h, --help      Show this help

Exit codes: 0 live, 1 degraded or unverified, 2 down, 3 usage or CLI error.

Not available yet: scan (Phase 3), check and login (Phase 4).`;

const UNBUILT: Record<string, string> = {
  scan: "Phase 3",
  check: "Phase 4",
  login: "Phase 4",
};

class UsageError extends Error {}

/** Loopback hosts may be checked only in tests (ADR 0013); testPolicy() enforces NODE_ENV=test. */
function policyFromEnv(env: Record<string, string | undefined>): FetchPolicy {
  const hosts = env.PULSE_TEST_ALLOW_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (!hosts?.length) return defaultPolicy();
  const ca = env.PULSE_TEST_CA_FILE ? readFileSync(env.PULSE_TEST_CA_FILE, "utf8") : undefined;
  return testPolicy(hosts, { ca, env });
}

function parsePulseArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      "fix-prompt": { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true as const };
  if (positionals.length !== 1) throw new UsageError("pulse takes exactly one URL");
  const raw = positionals[0] as string;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new UsageError(`only http and https URLs can be checked: ${raw}`);
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
      throw new UsageError("--timeout must be a whole number of milliseconds from 100 to 120000");
  }
  return {
    help: false as const,
    url: url.toString(),
    json: values.json,
    fixPrompt: values["fix-prompt"],
    timeoutMs,
  };
}

export function toJson(r: PulseResult, issues: IssueDraftOut[]) {
  const evidence = new Map(r.evidence.map((e) => [e.key, e]));
  return {
    url: r.url,
    final_url: r.finalUrl,
    status: r.status,
    gaps: r.gaps,
    platform: r.platform,
    duration_ms: Math.round(r.durationMs),
    findings: r.findings.map((f) => {
      const e = evidence.get(f.evidenceKey);
      return {
        code: f.code,
        severity: f.severity,
        locator: f.locator,
        discriminator: f.discriminator ?? null,
        message: f.message,
        evidence: e ? { kind: e.kind, locator: e.locator, payload: e.payload } : null,
      };
    }),
    issues: issues.map((i) => ({
      title: i.title,
      code: i.code,
      severity: i.severity,
      corroborating_codes: i.corroboratingCodes,
      summary: i.summary,
      recheck: i.recheck,
      prompt: {
        type: i.prompt.type,
        body: i.prompt.body,
        template_version: i.prompt.templateVersion,
      },
    })),
  };
}

export function toText(r: PulseResult, issues: IssueDraftOut[], fixPrompt: boolean): string {
  const lines: string[] = [];
  lines.push(`CodeSentra Pulse · ${r.url}`);
  lines.push(`Status: ${r.status.toUpperCase()}`);
  if (r.finalUrl && r.finalUrl !== r.url) lines.push(`Final URL: ${r.finalUrl}`);
  if (r.platform) lines.push(`Platform: ${r.platform.name} (${r.platform.environment})`);
  lines.push(`Took ${(r.durationMs / 1000).toFixed(1)} s`);
  if (r.gaps.length) {
    lines.push("", "Not checked:");
    for (const g of r.gaps) lines.push(`  ${g.group}: ${g.reason}`);
  }
  lines.push(
    "",
    issues.length ? `Issues (${issues.length}):` : "No issues found by the checks that ran.",
  );
  for (const i of issues) {
    lines.push(`  ${i.severity.toUpperCase().padEnd(7)} ${i.title}  [${i.code}]`);
    lines.push(`          ${i.summary}`);
    if (i.corroboratingCodes.length)
      lines.push(`          also shown by ${i.corroboratingCodes.join(", ")}`);
    lines.push(`          re-check: ${i.recheck.expectation}`);
  }
  const notes = r.findings.filter((f) => f.severity === "info");
  if (notes.length) {
    lines.push("", "Notes:");
    for (const f of notes) lines.push(`  ${f.message}`);
  }
  if (fixPrompt) {
    for (const i of issues) {
      lines.push(
        "",
        `── Fix prompt: ${i.title} (${i.prompt.type}, ${i.prompt.templateVersion}) ──`,
      );
      lines.push(i.prompt.body.trimEnd());
    }
  } else if (issues.length) {
    lines.push("", "Run again with --fix-prompt for a prompt per issue.");
  }
  return `${lines.join("\n")}\n`;
}

async function pulse(argv: string[], io: Io, deps: CliDeps): Promise<number> {
  const args = parsePulseArgs(argv);
  if (args.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  const policy = deps.policy ?? policyFromEnv(deps.env);
  const launched = await deps.launchBrowser();
  try {
    const result = await runPulse({
      url: args.url,
      policy,
      browser: launched.browser,
      browserUnavailableReason: launched.browser
        ? undefined
        : `${launched.reason} (install Chromium or set CHROMIUM_EXECUTABLE)`,
      timeoutMs: args.timeoutMs,
      onGroup: args.json
        ? undefined
        : (group, state) => {
            if (state !== "running") io.err(`  ${group}: ${state}\n`);
          },
    });
    const issues = draftIssues(result.findings, result.evidence, {
      target: { url: args.url, environment: null },
      project: null,
      platform: result.platform,
      lastSuccessfulCheck: null,
      scanSummary: null,
    });
    io.out(
      args.json
        ? `${JSON.stringify(toJson(result, issues), null, 2)}\n`
        : toText(result, issues, args.fixPrompt),
    );
    return EXIT[result.status];
  } finally {
    await launched.browser?.close();
  }
}

/** Entry point; returns the process exit code and never throws. */
export async function run(
  argv: string[],
  io: Io,
  deps: CliDeps = { env: process.env, launchBrowser: launchPulseBrowser },
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === "-h" || command === "--help" || command === "help") {
      io.out(`${USAGE}\n`);
      return command ? 0 : EXIT.usage;
    }
    if (command === "pulse") return await pulse(rest, io, deps);
    if (UNBUILT[command]) {
      io.err(`codesentra ${command} is not available yet (planned for ${UNBUILT[command]}).\n`);
      return EXIT.usage;
    }
    throw new UsageError(`unknown command: ${command}`);
  } catch (e) {
    const usage =
      e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    io.err(`codesentra: ${(e as Error).message}\n${usage ? `\n${USAGE}\n` : ""}`);
    return EXIT.usage;
  }
}
