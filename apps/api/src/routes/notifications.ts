import { keyring, sealSecret } from "@codesentra/core/crypto";
import { schema as s } from "@codesentra/db";
import { isSlackWebhookUrl, maskEmail, slackOauthExchange } from "@codesentra/notify";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { normalizeEmail } from "../auth/service.js";
import { sign, verify } from "../auth/tokens.js";
import { requireSessionUser } from "../authz.js";
import type { AppContext } from "../context.js";
import { badRequest, HttpError, notConfigured, notFound, Problem } from "../errors.js";
import { testAllowHosts } from "./scan.js";

/** Purpose bound into every sealed destination (email address or Slack webhook URL). */
export const NOTIFICATION_PURPOSE = "notification-target";
const STATE_TTL_MS = 15 * 60_000;
const MAX_CHANNELS = 20;

export const ChannelDto = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    kind: z.enum(["email", "slack"]),
    label: z.string().describe("Masked destination: a***@example.com or the Slack channel"),
    enabled: z.boolean(),
    last_error: z.string().nullable(),
    created_at: z.iso.datetime(),
  })
  .meta({ id: "NotificationChannel" });

type Row = typeof s.notificationChannels.$inferSelect;
const dto = (r: Row): z.infer<typeof ChannelDto> => ({
  id: r.id,
  project_id: r.projectId,
  kind: r.kind as "email" | "slack",
  label: r.label,
  enabled: r.enabled,
  last_error: r.lastError,
  created_at: r.createdAt.toISOString(),
});

interface SlackState {
  project: string;
  org: string;
  user: string;
  exp: number;
}

/**
 * Where a project's alerts go (Section 11: alerts carry each issue's prompt). Email goes
 * only to members of the org, so alerts cannot be aimed at outsiders; Slack is added with
 * "Add to Slack", never by pasting a URL.
 */
export function notificationRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const key = keyring(ctx.config.ENCRYPTION_KEY, ctx.config.ENCRYPTION_KEY_PREVIOUS);
  const appUrl = ctx.config.PUBLIC_APP_URL;
  const redirectUri = `${appUrl}/api/v1/slack/callback`;
  const testAllow = testAllowHosts(ctx);

  async function addChannel(
    orgId: string,
    userId: string,
    projectId: string,
    kind: "email" | "slack",
    target: string,
    label: string,
  ): Promise<Row> {
    return ctx.db.withOrg(orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(s.notificationChannels)
        .where(eq(s.notificationChannels.projectId, projectId));
      if (existing.length >= MAX_CHANNELS)
        throw badRequest(`A project can have at most ${MAX_CHANNELS} notification channels`);
      const [row] = await tx
        .insert(s.notificationChannels)
        .values({
          orgId,
          projectId,
          kind,
          label,
          sealed: sealSecret(target, key, NOTIFICATION_PURPOSE),
          createdBy: userId,
        })
        .returning();
      await tx.insert(s.auditLog).values({
        orgId,
        actorId: userId,
        action: "notification_channel.created",
        target: `notification_channel:${row?.id}`,
        metadata: { kind, label },
      });
      return row as Row;
    });
  }

  return async (app) => {
    app.get(
      "/v1/projects/:id/notifications",
      {
        schema: {
          tags: ["notifications"],
          summary: "Notification channels",
          params: z.object({ id: z.uuid() }),
          response: { 200: z.array(ChannelDto), 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const { orgId } = await ctx.authz.requireProject(req, req.params.id);
        const rows = await ctx.db.withOrg(orgId, (tx) =>
          tx
            .select()
            .from(s.notificationChannels)
            .where(eq(s.notificationChannels.projectId, req.params.id))
            .orderBy(desc(s.notificationChannels.createdAt)),
        );
        return rows.map(dto);
      },
    );

    app.post(
      "/v1/projects/:id/notifications",
      {
        schema: {
          tags: ["notifications"],
          summary: "Add an email channel",
          description:
            "Alerts (new and regressed issues, with their prompts) are emailed to this address. It must belong to a member of the organization. Slack channels are added with GET /v1/projects/{id}/notifications/slack/install.",
          params: z.object({ id: z.uuid() }),
          body: z.object({ kind: z.literal("email"), email: z.email().max(320) }),
          response: { 201: ChannelDto, 400: Problem, 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const email = normalizeEmail(req.body.email);
        const [member] = await ctx.db.system
          .select({ id: s.users.id })
          .from(s.users)
          .innerJoin(
            s.memberships,
            and(eq(s.memberships.userId, s.users.id), eq(s.memberships.orgId, access.orgId)),
          )
          .where(eq(s.users.email, email));
        if (!member) throw badRequest("Alerts can only be emailed to members of the organization");
        const row = await addChannel(
          access.orgId,
          access.user.id,
          req.params.id,
          "email",
          email,
          maskEmail(email),
        );
        return reply.code(201).send(dto(row));
      },
    );

    app.delete(
      "/v1/projects/:id/notifications",
      {
        schema: {
          tags: ["notifications"],
          summary: "Remove a notification channel",
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ channel_id: z.uuid() }),
          response: { 204: z.null(), 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        await ctx.db.withOrg(access.orgId, async (tx) => {
          const gone = await tx
            .delete(s.notificationChannels)
            .where(
              and(
                eq(s.notificationChannels.id, req.query.channel_id),
                eq(s.notificationChannels.projectId, req.params.id),
              ),
            )
            .returning({ id: s.notificationChannels.id });
          if (gone.length === 0) throw notFound("Notification channel");
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "notification_channel.deleted",
            target: `notification_channel:${req.query.channel_id}`,
          });
        });
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/v1/projects/:id/notifications/slack/install",
      {
        schema: {
          tags: ["notifications"],
          summary: "Add to Slack",
          description:
            "Redirects to Slack to pick a channel (incoming-webhook scope). Slack returns to /v1/slack/callback, which stores the webhook sealed.",
          params: z.object({ id: z.uuid() }),
          response: { 302: z.null(), 401: Problem, 404: Problem, 501: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        if (!ctx.config.integrations.slack || !ctx.config.SLACK_CLIENT_ID)
          throw notConfigured("Slack notifications", "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET");
        const state = sign(
          {
            project: req.params.id,
            org: access.orgId,
            user: access.user.id,
            exp: Date.now() + STATE_TTL_MS,
          } satisfies SlackState,
          ctx.config.SESSION_SECRET,
        );
        const u = new URL("/oauth/v2/authorize", ctx.config.SLACK_API_BASE_URL);
        u.searchParams.set("client_id", ctx.config.SLACK_CLIENT_ID);
        u.searchParams.set("scope", "incoming-webhook");
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("state", state);
        return reply.redirect(u.toString(), 302);
      },
    );

    app.get(
      "/v1/slack/callback",
      {
        schema: {
          tags: ["notifications"],
          summary: "Slack OAuth callback",
          querystring: z.object({
            code: z.string().max(512).optional(),
            state: z.string().max(2000),
            error: z.string().max(200).optional(),
          }),
          response: { 302: z.null(), 400: Problem, 401: Problem, 404: Problem, 501: Problem },
        },
      },
      async (req, reply) => {
        if (
          !ctx.config.integrations.slack ||
          !ctx.config.SLACK_CLIENT_ID ||
          !ctx.config.SLACK_CLIENT_SECRET
        )
          throw notConfigured("Slack notifications", "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET");
        const user = requireSessionUser(req);
        const st = verify<SlackState>(req.query.state, ctx.config.SESSION_SECRET);
        if (!st || st.exp < Date.now() || st.user !== user.id)
          throw badRequest("The Slack link expired or belongs to another session; start again");
        const access = await ctx.authz.requireProject(req, st.project);
        const back = `${appUrl}/projects/${st.project}/settings`;
        if (req.query.error || !req.query.code) return reply.redirect(`${back}?slack=denied`, 302);
        let hook: { url: string; channel: string };
        try {
          hook = await slackOauthExchange({
            apiBaseUrl: ctx.config.SLACK_API_BASE_URL,
            clientId: ctx.config.SLACK_CLIENT_ID,
            clientSecret: ctx.config.SLACK_CLIENT_SECRET,
            code: req.query.code,
            redirectUri,
            fetchImpl: ctx.fetch,
          });
        } catch (e) {
          throw new HttpError(502, "slack_failed", "Slack request failed", (e as Error).message);
        }
        if (!isSlackWebhookUrl(hook.url, testAllow))
          throw badRequest("Slack returned a webhook URL that is not on hooks.slack.com");
        await addChannel(access.orgId, user.id, st.project, "slack", hook.url, hook.channel);
        return reply.redirect(`${back}?slack=connected`, 302);
      },
    );
  };
}
