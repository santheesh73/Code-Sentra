import { FINDING_CODE_DECLARATIONS, type FindingCode } from "./finding-codes.js";

export interface GroupableFinding {
  code: FindingCode;
  /** Findings citing the same evidence describe the same observation. */
  evidenceKey: string;
}

export interface FindingGroup<T extends GroupableFinding> {
  /** The most specific finding; the issue is named and fingerprinted after it. */
  leader: T;
  /** All findings in the group, leader first. */
  members: T[];
}

/**
 * Section 10c merge rule: findings that share evidence collapse into one issue led by
 * the more specific code (e.g. one request raising UNDEFINED_IN_URL and
 * SAME_ORIGIN_FAILURE). Findings are never merged by URL alone, so two console errors
 * on the same page stay separate. Order is stable.
 */
export function groupFindings<T extends GroupableFinding>(
  findings: readonly T[],
): FindingGroup<T>[] {
  const byEvidence = new Map<string, T[]>();
  for (const f of findings) {
    const list = byEvidence.get(f.evidenceKey);
    if (list) list.push(f);
    else byEvidence.set(f.evidenceKey, [f]);
  }
  return [...byEvidence.values()].map((members) => {
    let leader = members[0] as T;
    for (const m of members) {
      if (
        FINDING_CODE_DECLARATIONS[m.code].specificity >
        FINDING_CODE_DECLARATIONS[leader.code].specificity
      ) {
        leader = m;
      }
    }
    return { leader, members: [leader, ...members.filter((m) => m !== leader)] };
  });
}

export interface RecheckSpec {
  module: "scan" | "pulse";
  check_group: string;
  target: string;
  expectation: string;
}

/** The stored re-check for an issue (Section 10d), from its code's declaration. */
export function recheckFor(code: FindingCode, locator: string, target: string): RecheckSpec {
  const d = FINDING_CODE_DECLARATIONS[code].recheck;
  return {
    module: d.module,
    check_group: d.checkGroup,
    target,
    expectation: d.expectation.replaceAll("{locator}", locator),
  };
}
