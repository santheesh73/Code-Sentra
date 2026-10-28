import { conclusionFor } from "@codesentra/github";

export interface ReportedIssue {
  title: string;
  code: string;
  severity: "error" | "warning" | "info";
  location: string | null;
  promptType: string;
  prompt: string;
}

export interface CheckRunReport {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  text: string;
}

const STATUS_LABEL: Record<string, string> = {
  live: "Live",
  degraded: "Degraded",
  down: "Down",
  unverified: "Unverified (some checks did not run)",
};

/** GitHub caps check run output fields at 65 535 characters. */
const LIMIT = 60_000;

/**
 * The "CodeSentra" check run for one commit (Section 16): the deployment's Pulse status
 * when there is one, the issues this commit introduces (each with its prompt), and the
 * files at risk from the change. Pure, so the exact wording is tested.
 */
export function checkRunReport(input: {
  pulseStatus: "live" | "degraded" | "down" | "unverified" | null;
  deploymentUrl: string | null;
  newIssues: ReportedIssue[];
  atRisk: { path: string; reason: string }[];
  changedFiles: string[];
  gaps: string[];
  runUrl: string;
}): CheckRunReport {
  const errors = input.newIssues.filter((i) => i.severity === "error").length;
  const conclusion = conclusionFor(input.pulseStatus, errors);
  const n = input.newIssues.length;
  const title = [
    input.pulseStatus ? STATUS_LABEL[input.pulseStatus] : null,
    n ? `${n} new issue${n === 1 ? "" : "s"}` : "no new issues",
  ]
    .filter(Boolean)
    .join(" · ");
  const summary = [
    input.pulseStatus
      ? `**Deployment:** ${STATUS_LABEL[input.pulseStatus]}${input.deploymentUrl ? ` — ${input.deploymentUrl}` : ""}`
      : "**Deployment:** not checked yet (waiting for a deployment of this commit)",
    `**New issues:** ${n}${errors ? ` (${errors} error${errors === 1 ? "" : "s"})` : ""}`,
    `**Changed files:** ${input.changedFiles.length} · **at risk:** ${input.atRisk.length}`,
    ...(input.gaps.length ? [`**Not checked:** ${input.gaps.join("; ")}`] : []),
    "",
    `[Open the full check in CodeSentra](${input.runUrl})`,
  ].join("\n");
  const sections = input.newIssues.map((i) =>
    [
      `### ${i.severity === "error" ? "🔴" : i.severity === "warning" ? "🟡" : "⚪"} ${i.title}`,
      `\`${i.code}\`${i.location ? ` at \`${i.location}\`` : ""} · prompt: ${i.promptType}`,
      "",
      "<details><summary>Fix prompt</summary>",
      "",
      i.prompt.trim(),
      "",
      "</details>",
    ].join("\n"),
  );
  const atRisk = input.atRisk.length
    ? [
        "### Files at risk from this change",
        ...input.atRisk.slice(0, 50).map((a) => `- \`${a.path}\` — ${a.reason}`),
      ].join("\n")
    : "";
  let text = [...sections, atRisk].filter(Boolean).join("\n\n");
  if (text.length > LIMIT)
    text = `${text.slice(0, LIMIT)}\n\n…truncated: the full list is in CodeSentra (${input.runUrl}).`;
  return { conclusion, title, summary, text };
}
