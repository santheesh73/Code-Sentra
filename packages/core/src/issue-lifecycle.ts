import type { IssueEventKind, IssueStatus } from "./enums.js";

export interface RecheckObservation {
  /** Whether the check group named by the issue's re-check descriptor ran in this run. */
  checkGroupRan: boolean;
  /** Whether a finding with the issue's fingerprint was observed in this run. */
  observed: boolean;
}

export interface IssueTransition {
  status: IssueStatus;
  /** Event to append to `issue_events`, or null when nothing changes and nothing was seen. */
  event: IssueEventKind | null;
}

/**
 * Section 10d re-check rule. A skipped check group never resolves an issue
 * (Rule 2), and dismissed issues are only changed by an explicit user action.
 */
export function nextIssueStatus(current: IssueStatus, obs: RecheckObservation): IssueTransition {
  if (current === "dismissed") {
    return { status: "dismissed", event: null };
  }
  if (!obs.checkGroupRan) {
    return { status: current, event: null };
  }
  switch (current) {
    case "open":
    case "regressed":
      return obs.observed
        ? { status: current, event: "seen" }
        : { status: "resolved", event: "resolved" };
    case "resolved":
      return obs.observed
        ? { status: "regressed", event: "regressed" }
        : { status: "resolved", event: null };
  }
}
