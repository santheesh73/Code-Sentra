import { openSecret } from "@codesentra/core/crypto";
import { type Database, schema as s } from "@codesentra/db";
import { type AlertIssue, type EmailTransport, postSlack, renderAlert } from "@codesentra/notify";
import { and, desc, eq, inArray } from "drizzle-orm";

/** Purpose the API seals channel destinations with (routes/notifications.ts). */
const PURPOSE = "notification-target";

export interface Notifier {
  encryptionKey: string;
  /** null when the email integration is off: email channels then record that. */
  email: EmailTransport | null;
  /** The SSRF-safe fetch Slack webhooks are posted through. */
  slackFetch: (url: string, init: RequestInit) => Promise<Response>;
}

export interface NotifyResult {
  sent: number;
  failed: number;
}

/**
 * Sends the alert for a sync-mode Link run that opened or regressed issues to every
 * enabled channel of the project. A channel that fails records its error and does not
 * stop the others. Runs after the issues are committed, so links in the alert resolve.
 */
export async function notifyChannels(
  db: Database,
  n: Notifier,
  input: {
    orgId: string;
    projectId: string;
    appUrl: string;
    runId: string;
    pulseStatus: "live" | "degraded" | "down" | "unverified" | null;
    opened: string[];
    regressed: string[];
  },
): Promise<NotifyResult> {
  const ids = [...input.opened, ...input.regressed];
  if (ids.length === 0) return { sent: 0, failed: 0 };
  const loaded = await db.withOrg(input.orgId, async (tx) => {
    const channels = await tx
      .select()
      .from(s.notificationChannels)
      .where(
        and(
          eq(s.notificationChannels.projectId, input.projectId),
          eq(s.notificationChannels.enabled, true),
        ),
      );
    if (channels.length === 0) return null;
    const [project] = await tx.select().from(s.projects).where(eq(s.projects.id, input.projectId));
    const issues = await tx.select().from(s.issues).where(inArray(s.issues.id, ids));
    const prompts = await tx
      .select()
      .from(s.fixPrompts)
      .where(inArray(s.fixPrompts.issueId, ids))
      .orderBy(desc(s.fixPrompts.version));
    const traces = await tx
      .select({ issueId: s.traces.issueId, path: s.traces.path, line: s.traces.line })
      .from(s.traces)
      .where(and(inArray(s.traces.issueId, ids), eq(s.traces.runId, input.runId)));
    return { channels, project, issues, prompts, traces };
  });
  if (!loaded) return { sent: 0, failed: 0 };

  const rank = { error: 0, warning: 1, info: 2 } as const;
  const alertIssues: AlertIssue[] = loaded.issues
    .map((i) => {
      const prompt = loaded.prompts.find((p) => p.issueId === i.id);
      const t = loaded.traces.find((x) => x.issueId === i.id);
      return {
        title: i.title,
        code: i.code,
        severity: i.severity,
        change: input.regressed.includes(i.id) ? ("regressed" as const) : ("opened" as const),
        location: t ? `${t.path}${t.line ? `:${t.line}` : ""}` : i.locator,
        promptType: prompt?.type ?? null,
        prompt: prompt?.body ?? null,
        url: `${input.appUrl}/issues/${i.id}`,
      };
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const alert = renderAlert({
    projectName: loaded.project?.name ?? "project",
    pulseStatus: input.pulseStatus,
    runUrl: `${input.appUrl}/runs/${input.runId}`,
    issues: alertIssues,
  });

  const result: NotifyResult = { sent: 0, failed: 0 };
  for (const c of loaded.channels) {
    let error: string | null = null;
    try {
      const target = openSecret(c.sealed, n.encryptionKey, PURPOSE);
      if (c.kind === "email") {
        if (!n.email)
          throw new Error("email is not configured (EMAIL_FROM, EMAIL_PROVIDER_API_KEY)");
        await n.email.send({
          to: target,
          subject: alert.subject,
          text: alert.text,
          html: alert.html,
        });
      } else {
        await postSlack(target, alert.slack, n.slackFetch);
      }
      result.sent++;
    } catch (e) {
      // Never echo the destination: a Slack webhook URL is a secret.
      error = (e as Error).message.replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
      result.failed++;
    }
    await db.withOrg(input.orgId, (tx) =>
      tx
        .update(s.notificationChannels)
        .set({ lastError: error })
        .where(eq(s.notificationChannels.id, c.id)),
    );
  }
  return result;
}
