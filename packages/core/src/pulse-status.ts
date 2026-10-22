import type { PulseCheckGroup, PulseStatus, Severity } from "./enums.js";

export type MainUrlOutcome =
  | { reachable: true; status: number }
  | {
      reachable: false;
      failure:
        | "dns"
        | "tls_invalid"
        | "timeout"
        | "server_error"
        | "connection"
        | "redirect_loop"
        | "too_many_redirects"
        | "blocked";
      status?: number;
    };

export interface CheckGroupOutcome {
  group: PulseCheckGroup;
  ran: boolean;
  /** Required when `ran` is false (Rule 2). */
  gapReason?: string;
}

export interface PulseStatusInput {
  main: MainUrlOutcome;
  /** Check groups expected for this run. Groups not applicable must still be listed with a reason. */
  groups: CheckGroupOutcome[];
  findings: { severity: Severity }[];
}

export interface PulseStatusResult {
  status: PulseStatus;
  /** Groups that did not run, with reasons. Never treated as passes. */
  gaps: { group: PulseCheckGroup; reason: string }[];
}

/**
 * Section 9 status rule.
 * - down: main URL failed (DNS, TLS invalid, timeout, 5xx, connection failure,
 *   redirect loop or an over-long chain: users cannot load the page).
 * - unverified (not down): the target was refused by the SSRF policy. CodeSentra did
 *   not check it, so it reports a gap instead of claiming the site is down.
 * - degraded: main URL loads and at least one error-severity finding exists.
 * - live: main URL loads, every check group ran, no error findings.
 * - unverified: main URL loads, no error findings, at least one group did not run.
 */
export function computePulseStatus(input: PulseStatusInput): PulseStatusResult {
  const gaps = input.groups
    .filter((g) => !g.ran)
    .map((g) => ({
      group: g.group,
      reason: g.gapReason?.trim() || "check group did not run (no reason recorded)",
    }));

  const main = input.main;
  if (!main.reachable && main.failure === "blocked") {
    // One gap per group: keep the reason the reachability group recorded, if any.
    if (!gaps.some((g) => g.group === "reachability"))
      gaps.unshift({
        group: "reachability",
        reason: "the target resolves to a non-public address and was not contacted",
      });
    return { status: "unverified", gaps };
  }
  if (!main.reachable || main.status >= 500) {
    return { status: "down", gaps };
  }
  if (input.findings.some((f) => f.severity === "error")) {
    return { status: "degraded", gaps };
  }
  if (gaps.length > 0 || input.groups.length === 0) {
    if (input.groups.length === 0) {
      gaps.push({ group: "reachability", reason: "no check groups were recorded for this run" });
    }
    return { status: "unverified", gaps };
  }
  return { status: "live", gaps };
}
