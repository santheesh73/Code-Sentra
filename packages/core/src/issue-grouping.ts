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
 * SAME_ORIGIN_FAILURE). Only different codes corroborate each other: two findings with
 * the same code are two problems even when they cite the same evidence (one response
 * missing two security headers), so the second becomes its own group. Findings are never
 * merged by URL alone, so two console errors on the same page stay separate. Order is
 * stable.
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
  const groups: FindingGroup<T>[] = [];
  for (const shared of byEvidence.values()) {
    let leader = shared[0] as T;
    for (const m of shared) {
      if (
        FINDING_CODE_DECLARATIONS[m.code].specificity >
        FINDING_CODE_DECLARATIONS[leader.code].specificity
      ) {
        leader = m;
      }
    }
    const members = [leader];
    const seen = new Set<FindingCode>([leader.code]);
    const alone: T[] = [];
    for (const m of shared) {
      if (m === leader) continue;
      if (seen.has(m.code)) alone.push(m);
      else {
        seen.add(m.code);
        members.push(m);
      }
    }
    groups.push({ leader, members }, ...alone.map((m) => ({ leader: m, members: [m] })));
  }
  return groups;
}

export interface RecheckSpec {
  module: "scan" | "pulse";
  check_group: string;
  target: string;
  expectation: string;
}

/** Discriminators can be whole error messages; an expectation names the first line. */
function clip(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * The stored re-check for an issue (Section 10d), from its code's declaration.
 * `discriminator` fills `{discriminator}` (which header, which message).
 */
export function recheckFor(
  code: FindingCode,
  locator: string,
  target: string,
  discriminator?: string | null,
): RecheckSpec {
  const d = FINDING_CODE_DECLARATIONS[code].recheck;
  return {
    module: d.module,
    check_group: d.checkGroup,
    target,
    expectation: d.expectation
      .replaceAll("{locator}", locator)
      .replaceAll("{discriminator}", clip(discriminator ?? locator)),
  };
}
