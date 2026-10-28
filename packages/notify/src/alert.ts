/**
 * The alert a project's notification channels receive when a check opens or regresses
 * issues (Section 11: prompts are delivered in alert notifications). Pure, so the exact
 * email and Slack wording is tested.
 */
export interface AlertIssue {
  title: string;
  code: string;
  severity: "error" | "warning" | "info";
  change: "opened" | "regressed";
  location: string | null;
  promptType: string | null;
  prompt: string | null;
  url: string;
}

export interface AlertInput {
  projectName: string;
  /** The deployment's Pulse status when the run checked one. */
  pulseStatus: "live" | "degraded" | "down" | "unverified" | null;
  runUrl: string;
  issues: AlertIssue[];
}

export interface Alert {
  subject: string;
  text: string;
  html: string;
  slack: { text: string; blocks: unknown[] };
}

const STATUS: Record<string, string> = {
  live: "Live",
  degraded: "Degraded",
  down: "Down",
  unverified: "Unverified",
};
const ICON = { error: "🔴", warning: "🟡", info: "⚪" } as const;
/** Slack section text is capped at 3000 characters; longer prompts link to the issue. */
const SLACK_PROMPT_MAX = 2500;
const MAX_ISSUES = 20;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Slack mrkdwn treats &, < and > as control characters. */
const slackEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderAlert(input: AlertInput): Alert {
  const opened = input.issues.filter((i) => i.change === "opened").length;
  const regressed = input.issues.length - opened;
  const counts = [
    opened ? `${opened} new issue${opened === 1 ? "" : "s"}` : null,
    regressed ? `${regressed} regressed` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const status = input.pulseStatus ? STATUS[input.pulseStatus] : null;
  const subject = `[CodeSentra] ${input.projectName}: ${counts || "no changes"}${status ? ` · ${status}` : ""}`;
  const shown = input.issues.slice(0, MAX_ISSUES);
  const more = input.issues.length - shown.length;

  const text = [
    `${input.projectName}: ${counts}${status ? ` (deployment: ${status})` : ""}`,
    "",
    ...shown.flatMap((i) => [
      `${i.change === "regressed" ? "REGRESSED" : "NEW"} ${i.severity.toUpperCase()} ${i.title}`,
      `  ${i.code}${i.location ? ` at ${i.location}` : ""} — ${i.url}`,
      ...(i.prompt
        ? [
            "",
            `  Fix prompt (${i.promptType}):`,
            ...i.prompt
              .trim()
              .split("\n")
              .map((l) => `    ${l}`),
          ]
        : []),
      "",
    ]),
    ...(more > 0 ? [`…and ${more} more: ${input.runUrl}`] : []),
    `Full check: ${input.runUrl}`,
  ].join("\n");

  const html = [
    `<p><strong>${esc(input.projectName)}</strong>: ${esc(counts)}${status ? ` · deployment <strong>${esc(status)}</strong>` : ""}</p>`,
    ...shown.map(
      (i) =>
        `<h3>${ICON[i.severity]} ${i.change === "regressed" ? "Regressed: " : ""}${esc(i.title)}</h3>` +
        `<p><code>${esc(i.code)}</code>${i.location ? ` at <code>${esc(i.location)}</code>` : ""} — <a href="${esc(i.url)}">open issue</a></p>` +
        (i.prompt
          ? `<p>Fix prompt (${esc(i.promptType ?? "")}):</p><pre style="white-space:pre-wrap">${esc(i.prompt.trim())}</pre>`
          : ""),
    ),
    ...(more > 0 ? [`<p>…and ${more} more.</p>`] : []),
    `<p><a href="${esc(input.runUrl)}">Open the full check in CodeSentra</a></p>`,
  ].join("\n");

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${slackEsc(input.projectName)}*: ${counts}${status ? ` · deployment *${status}*` : ""}`,
      },
    },
    ...shown.flatMap((i) => {
      const prompt = i.prompt?.trim() ?? "";
      const clipped =
        prompt.length > SLACK_PROMPT_MAX
          ? `${prompt.slice(0, SLACK_PROMPT_MAX)}\n…(full prompt in CodeSentra)`
          : prompt;
      return [
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${ICON[i.severity]} *${i.change === "regressed" ? "Regressed: " : ""}<${i.url}|${slackEsc(i.title)}>*\n\`${i.code}\`${i.location ? ` at \`${slackEsc(i.location)}\`` : ""}`,
          },
        },
        ...(clipped
          ? [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Fix prompt (${i.promptType}):\n\`\`\`${slackEsc(clipped)}\`\`\``,
                },
              },
            ]
          : []),
      ];
    }),
    ...(more > 0
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: `…and ${more} more` }] }]
      : []),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${input.runUrl}|Open the full check in CodeSentra>` }],
    },
  ];
  // Slack allows 50 blocks per message.
  return { subject, text, html, slack: { text: subject, blocks: blocks.slice(0, 50) } };
}

/** Masks an address for display: `a***@example.com`. */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}
