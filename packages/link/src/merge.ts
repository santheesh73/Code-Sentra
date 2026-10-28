/**
 * Cross-module merge (Section 10b merge rules): a Pulse issue traced to code that reads an
 * env var, and a Scan finding that the same env var is undocumented at that same file,
 * are one problem. The Scan finding becomes a corroborating finding of the Pulse issue
 * instead of a second issue. Pure, so the rule is tested on its own.
 */
export interface TracedPulseIssue {
  key: string;
  envVars: string[];
  sites: { path: string; line: number | null }[];
}

export interface ScanEnvFinding {
  key: string;
  code: string;
  envVar: string | null;
  path: string;
  /** Already an open or regressed project issue: never merged away (its lifecycle stays). */
  alreadyOpen: boolean;
}

export const MERGEABLE_SCAN_CODES = new Set(["ENV_VAR_UNDOCUMENTED"]);

/** Scan finding key → the Pulse issue key it corroborates. */
export function mergeEnvFindings(
  pulse: TracedPulseIssue[],
  scan: ScanEnvFinding[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of scan) {
    if (!MERGEABLE_SCAN_CODES.has(f.code) || !f.envVar || f.alreadyOpen) continue;
    const target = pulse.find(
      (p) => p.envVars.includes(f.envVar as string) && p.sites.some((s) => s.path === f.path),
    );
    if (target) out.set(f.key, target.key);
  }
  return out;
}
