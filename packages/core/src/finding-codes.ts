import { z } from "zod";
import type { Module, PromptType, PulseCheckGroup, ScanCheckGroup, Severity } from "./enums.js";

export const SCAN_CODES = [
  "BUILD_FAILED",
  "TESTS_FAILING",
  "TYPECHECK_ERRORS",
  "LINT_ERRORS",
  "VULNERABLE_DEPENDENCY",
  "SECRET_EXPOSED",
  "ENV_VAR_UNDOCUMENTED",
  "ENV_VAR_UNUSED",
  "TODO_MARKER",
  "STUB_IMPLEMENTATION",
  "SKIPPED_TESTS",
  "HOTSPOT",
  "NO_TESTS",
  "MISSING_BUILD_SCRIPT",
  "DOCUMENTED_FEATURE_MISSING",
] as const;

export const PULSE_CODES = [
  "DOWN",
  "DNS_FAILURE",
  "TLS_INVALID",
  "TLS_EXPIRING",
  "TIMEOUT",
  "SERVER_ERROR",
  "BAD_STATUS",
  "REDIRECT_LOOP",
  "LONG_REDIRECT_CHAIN",
  "SLOW_RESPONSE",
  "ACCESS_PROTECTED",
  "PREVIEW_SERVED_AS_PROD",
  "UNDEFINED_IN_URL",
  "LOCALHOST_CALL",
  "SAME_ORIGIN_FAILURE",
  "CONSOLE_ERROR",
  "UNCAUGHT_EXCEPTION",
  "BLANK_PAGE",
  "ROUTE_BROKEN",
  "ROUTE_MISSING",
  "MIXED_CONTENT",
  "MISSING_SECURITY_HEADER",
] as const;

export const ScanCode = z.enum(SCAN_CODES);
export type ScanCode = z.infer<typeof ScanCode>;
export const PulseCode = z.enum(PULSE_CODES);
export type PulseCode = z.infer<typeof PulseCode>;
export const FindingCode = z.enum([...SCAN_CODES, ...PULSE_CODES]);
export type FindingCode = z.infer<typeof FindingCode>;

/**
 * How a later run decides whether the problem is still present. A re-check only
 * counts when `checkGroup` actually ran in that later run (Section 10d).
 */
export type RecheckDescriptor =
  | {
      module: "pulse";
      checkGroup: PulseCheckGroup;
      /**
       * Human-readable expectation; `{locator}` is replaced with the issue's locator and
       * `{discriminator}` with its discriminator (the locator when it has none).
       */
      expectation: string;
    }
  | {
      module: "scan";
      checkGroup: ScanCheckGroup;
      expectation: string;
    };

export interface FindingCodeDeclaration {
  code: FindingCode;
  module: Module;
  defaultSeverity: Severity;
  /**
   * Prompt type when the issue can be handled with this type. For `code_fix`
   * codes raised by Pulse, the type falls back to `investigate` when no
   * verified trace exists (`requiresTrace`).
   */
  promptType: PromptType;
  requiresTrace: boolean;
  /**
   * Specificity used when findings sharing evidence collapse into one issue:
   * the higher value leads (Section 10c).
   */
  specificity: number;
  recheck: RecheckDescriptor;
  title: string;
}

type Decl = Omit<FindingCodeDeclaration, "code" | "module">;

const scan = (
  checkGroup: ScanCheckGroup,
  defaultSeverity: Severity,
  promptType: PromptType,
  title: string,
  expectation: string,
): Decl => ({
  defaultSeverity,
  promptType,
  requiresTrace: false,
  specificity: 50,
  recheck: { module: "scan", checkGroup, expectation },
  title,
});

const pulse = (
  checkGroup: PulseCheckGroup,
  defaultSeverity: Severity,
  promptType: PromptType,
  title: string,
  expectation: string,
  specificity: number,
): Decl => ({
  defaultSeverity,
  promptType,
  requiresTrace: promptType === "code_fix",
  specificity,
  recheck: { module: "pulse", checkGroup, expectation },
  title,
});

const SCAN_DECLS: Record<ScanCode, Decl> = {
  BUILD_FAILED: scan("build", "error", "outage_triage", "Build fails", "install and build succeed"),
  TESTS_FAILING: scan("tests", "error", "code_fix", "Tests are failing", "test {locator} passes"),
  TYPECHECK_ERRORS: scan(
    "typecheck",
    "error",
    "code_fix",
    "Type errors",
    "no type error at {locator}",
  ),
  LINT_ERRORS: scan("lint", "warning", "code_fix", "Lint errors", "no lint error at {locator}"),
  VULNERABLE_DEPENDENCY: scan(
    "dependency_audit",
    "warning",
    "code_fix",
    "Vulnerable dependency",
    "advisory {locator} no longer applies to the lockfile",
  ),
  SECRET_EXPOSED: scan(
    "secrets",
    "error",
    "code_fix",
    "Secret committed to the repository",
    "no secret detected at {locator}",
  ),
  ENV_VAR_UNDOCUMENTED: scan(
    "map",
    "warning",
    "code_fix",
    "Environment variable is read but not documented",
    "{locator} is documented in .env.example or docs",
  ),
  ENV_VAR_UNUSED: scan(
    "map",
    "info",
    "code_fix",
    "Documented environment variable is never read",
    "{locator} is read in code or removed from docs",
  ),
  TODO_MARKER: scan("map", "info", "code_fix", "TODO marker", "no TODO/FIXME marker at {locator}"),
  STUB_IMPLEMENTATION: scan(
    "map",
    "warning",
    "code_fix",
    "Stub implementation",
    "{locator} is implemented",
  ),
  SKIPPED_TESTS: scan("tests", "warning", "code_fix", "Skipped tests", "{locator} is not skipped"),
  HOTSPOT: scan(
    "history",
    "info",
    "code_fix",
    "Hotspot: high churn and high fan-in",
    "{locator} is no longer in the top churn and fan-in decile",
  ),
  NO_TESTS: scan("map", "warning", "code_fix", "No tests", "at least one test exists"),
  MISSING_BUILD_SCRIPT: scan(
    "map",
    "warning",
    "code_fix",
    "No build script",
    "a build script is declared",
  ),
  DOCUMENTED_FEATURE_MISSING: scan(
    "inventory",
    "warning",
    "code_fix",
    "Documented feature has no implementation",
    "feature {locator} has implementation evidence",
  ),
};

const PULSE_DECLS: Record<PulseCode, Decl> = {
  DOWN: pulse("reachability", "error", "outage_triage", "Site is down", "{locator} responds", 10),
  DNS_FAILURE: pulse(
    "reachability",
    "error",
    "outage_triage",
    "DNS lookup fails",
    "{locator} resolves",
    40,
  ),
  TLS_INVALID: pulse(
    "reachability",
    "error",
    "outage_triage",
    "TLS certificate is invalid",
    "{locator} presents a valid certificate",
    40,
  ),
  TLS_EXPIRING: pulse(
    "reachability",
    "warning",
    "outage_triage",
    "TLS certificate expires within 14 days",
    "{locator} certificate is valid for at least 14 more days",
    40,
  ),
  TIMEOUT: pulse(
    "reachability",
    "error",
    "outage_triage",
    "Request times out",
    "{locator} responds within the timeout",
    40,
  ),
  SERVER_ERROR: pulse(
    "reachability",
    "error",
    "outage_triage",
    "Server error",
    "{locator} does not return 5xx",
    40,
  ),
  BAD_STATUS: pulse(
    "reachability",
    "error",
    "outage_triage",
    "Unexpected status code",
    "{locator} returns 2xx",
    30,
  ),
  REDIRECT_LOOP: pulse(
    "reachability",
    "error",
    "config_fix",
    "Redirect loop",
    "{locator} redirect chain terminates",
    40,
  ),
  LONG_REDIRECT_CHAIN: pulse(
    "reachability",
    "warning",
    "config_fix",
    "Redirect chain longer than 3 hops",
    "{locator} redirects at most 3 times",
    30,
  ),
  SLOW_RESPONSE: pulse(
    "reachability",
    "warning",
    "investigate",
    "Slow response",
    "{locator} TTFB under the threshold",
    30,
  ),
  ACCESS_PROTECTED: pulse(
    "platform",
    "warning",
    "config_fix",
    "Deployment is behind platform access protection",
    "{locator} is publicly reachable or the bypass token works",
    50,
  ),
  PREVIEW_SERVED_AS_PROD: pulse(
    "platform",
    "error",
    "config_fix",
    "Preview deployment served as production",
    "{locator} is served by a production deployment",
    50,
  ),
  UNDEFINED_IN_URL: pulse(
    "render",
    "error",
    "code_fix",
    "Request URL contains an undefined value",
    "no request matching {locator}",
    90,
  ),
  LOCALHOST_CALL: pulse(
    "render",
    "error",
    "code_fix",
    "Production page calls localhost",
    "no request to {locator}",
    90,
  ),
  SAME_ORIGIN_FAILURE: pulse(
    "render",
    "error",
    "code_fix",
    "Same-origin request fails",
    "no failing same-origin request to {locator}",
    60,
  ),
  CONSOLE_ERROR: pulse(
    "render",
    "warning",
    "code_fix",
    "Console error",
    "console error {locator} not logged",
    70,
  ),
  UNCAUGHT_EXCEPTION: pulse(
    "render",
    "error",
    "code_fix",
    "Uncaught exception",
    "exception {locator} not thrown",
    80,
  ),
  BLANK_PAGE: pulse(
    "render",
    "error",
    "code_fix",
    "Page renders blank",
    "{locator} renders visible content",
    50,
  ),
  ROUTE_BROKEN: pulse(
    "routes",
    "error",
    "code_fix",
    "Route returns an error",
    "{locator} returns 2xx",
    60,
  ),
  ROUTE_MISSING: pulse(
    "routes",
    "error",
    "code_fix",
    "Linked route does not exist",
    "{locator} exists or is no longer linked",
    70,
  ),
  MIXED_CONTENT: pulse(
    "render",
    "warning",
    "code_fix",
    "Mixed content",
    "no insecure subresource {locator}",
    70,
  ),
  MISSING_SECURITY_HEADER: pulse(
    "hygiene",
    "warning",
    "config_fix",
    "Missing security header",
    "the response from {locator} sets {discriminator}",
    50,
  ),
};

export const FINDING_CODE_DECLARATIONS: Readonly<Record<FindingCode, FindingCodeDeclaration>> =
  Object.freeze({
    ...Object.fromEntries(
      Object.entries(SCAN_DECLS).map(([code, d]) => [
        code,
        { ...d, code: code as FindingCode, module: "scan" as const },
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(PULSE_DECLS).map(([code, d]) => [
        code,
        { ...d, code: code as FindingCode, module: "pulse" as const },
      ]),
    ),
  } as Record<FindingCode, FindingCodeDeclaration>);

export function declarationFor(code: FindingCode): FindingCodeDeclaration {
  return FINDING_CODE_DECLARATIONS[code];
}

/** Resolves the prompt type for an issue given whether a verified trace exists. */
export function promptTypeFor(code: FindingCode, hasVerifiedTrace: boolean): PromptType {
  const decl = FINDING_CODE_DECLARATIONS[code];
  if (decl.requiresTrace && !hasVerifiedTrace) return "investigate";
  return decl.promptType;
}
