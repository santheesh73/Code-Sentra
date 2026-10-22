import type { RunStatus, RunStepStatus } from "./enums.js";

/**
 * Final run status from its steps once none is pending or running.
 * - any failed step → failed
 * - otherwise any skipped step → partial (a skipped check is never a pass, Rule 2)
 * - otherwise → succeeded
 * A run with no steps did nothing verifiable and is failed.
 */
export function deriveRunStatus(steps: readonly { status: RunStepStatus }[]): RunStatus {
  if (steps.length === 0) return "failed";
  if (steps.some((s) => s.status === "pending" || s.status === "running")) {
    throw new Error("deriveRunStatus called before every step finished");
  }
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "skipped")) return "partial";
  return "succeeded";
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "partial"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}
