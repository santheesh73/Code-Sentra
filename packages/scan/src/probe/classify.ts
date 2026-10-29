/**
 * Why a dependency download or offline install failed (ADR 0030, audit F-05). A failure the
 * network or the environment caused is a coverage gap — the project was not measured, which
 * is Unverified, never a finding against the code. A failure the project's own manifests
 * caused (a version that does not exist, a corrupt artifact, a lockfile out of sync) is a real
 * BUILD_FAILED, reported with the tool's own message. Anything unrecognised is treated as a
 * gap: CodeSentra does not blame the project for a failure it cannot attribute to it.
 */
export type FailureKind = "infra" | "dependency";

export interface Classified {
  kind: FailureKind;
  reason: string;
}

/** The project's manifests are at fault: report BUILD_FAILED with the tool's message. */
const DEPENDENCY = [
  /\bERR_PNPM_NO_MATCHING_VERSION\b/,
  /No matching version found for/i,
  /notarget|ETARGET/,
  /\bEINTEGRITY\b|ERR_PNPM_TARBALL_INTEGRITY|integrity check(sum)? failed|computed integrity/i,
  /ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*(out of date|not up to date|outdated|needs? to be updated)/i,
  /Your lockfile needs to be updated/i,
  /can only install packages when your package\.json and package-lock\.json/i,
  /\bERESOLVE\b|unable to resolve dependency tree/i,
  /Cannot read propert.*of (undefined|null).*package\.json|Invalid package\.json/i,
  /This package doesn't seem to be present in your lockfile/i,
];

/** The network or environment is at fault: a coverage gap, not the project's error. */
const INFRA = [
  /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE/,
  /getaddrinfo|Could not resolve host|Temporary failure in name resolution/i,
  /socket hang ?up|network (timeout|error)|request to .* failed|fetch failed/i,
  /tunnel(ing)? socket|through a proxy|proxy (error|connect)|CONNECT/i,
  /\b(403 Forbidden|407 Proxy|429 Too Many Requests|50[0-9] )/,
  /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_(401|403|404|429|50\d)|registry returned 50\d/i,
  /self[- ]signed certificate|unable to (verify|get local issuer)|CERT_|SSL/i,
];

const match = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

/** The tail of the output, trimmed, as the human-facing reason. */
function lastMeaningful(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\s*$/.test(l));
  return lines.slice(-1)[0] ?? "no output";
}

export function classifyFetchFailure(
  output: string,
  exitCode: number | null,
  timedOut: boolean,
): Classified {
  if (timedOut) return { kind: "infra", reason: "the dependency download timed out" };
  // A recognised dependency error is the project's; the tool's last line carries the detail.
  if (match(DEPENDENCY, output)) return { kind: "dependency", reason: lastMeaningful(output) };
  if (match(INFRA, output))
    return {
      kind: "infra",
      reason: `the dependency download could not reach a registry: ${lastMeaningful(output)}`,
    };
  if (exitCode === null)
    return { kind: "infra", reason: "the dependency download was terminated before it finished" };
  // Unattributable: do not blame the project (evidence first).
  return {
    kind: "infra",
    reason: `the dependency download failed for a reason CodeSentra could not attribute to the project: ${lastMeaningful(output)}`,
  };
}
