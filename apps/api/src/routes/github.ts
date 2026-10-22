import { PULSE_GROUPS } from "@codesentra/checks";
import { ScanStage } from "@codesentra/core";
import { openSecret, sealSecret } from "@codesentra/core/crypto";
import { createSnapshot, schema as s } from "@codesentra/db";
import {
  DeploymentStatusEvent,
  type GithubApp,
  InstallationEvent,
  InstallationRepositoriesEvent,
  PullRequestEvent,
  PushEvent,
  verifyWebhookSignature,
} from "@codesentra/github";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sign, verify } from "../auth/tokens.js";
import { requireUser } from "../authz.js";
import type { AppContext } from "../context.js";
import {
  badRequest,
  conflict,
  HttpError,
  notConfigured,
  Problem,
  unauthorized,
} from "../errors.js";
import { type ChildRun, startLinked } from "../orchestrate.js";
import { assertPublicTarget } from "./pulse.js";
import { testAllowHosts } from "./scan.js";

const PURPOSE = "github-installation";
const STATE_TTL_MS = 15 * 60_000;
const APP_VARS =
  "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET";

interface InstallState {
  org: string;
  user: string;
  exp: number;
}
interface InstallationData {
  account: string | null;
  repositories: string[];
}

type Handled = { status: "processed" | "ignored"; detail: string };

/** Body of a webhook request, kept verbatim for the signature (app.ts content parser). */
export const rawBodyOf = (req: unknown): string | undefined =>
  (req as { rawBody?: string }).rawBody;

/**
 * The GitHub App (Section 16): webhooks (signed, deduplicated by X-GitHub-Delivery) start
 * pull request and deployment checks that report into the commit's "CodeSentra" check
 * run; install/setup link an installation to an organization (ADR 0021).
 */
export function githubRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const key = ctx.config.ENCRYPTION_KEY;
  const seal = (d: InstallationData) => sealSecret(JSON.stringify(d), key, PURPOSE);
  const open = (sealed: string): InstallationData => JSON.parse(openSecret(sealed, key, PURPOSE));
  const configured = (): GithubApp => {
    if (!ctx.config.integrations.github_app || !ctx.github || !ctx.config.GITHUB_WEBHOOK_SECRET)
      throw notConfigured("The GitHub App", APP_VARS);
    return ctx.github;
  };

  /** Projects bound to `repo` in the org that linked this installation (never another's). */
  async function projectsFor(installationId: number, repo: string) {
    return ctx.db.system
      .select({ project: s.projects })
      .from(s.projects)
      .innerJoin(
        s.githubInstallations,
        and(
          eq(s.githubInstallations.orgId, s.projects.orgId),
          eq(s.githubInstallations.installationId, installationId),
          eq(s.githubInstallations.suspended, false),
        ),
      )
      .where(sql`lower(${s.projects.githubRepo}) = lower(${repo})`)
      .then((rows) => rows.map((r) => r.project));
  }

  async function upsertInstallation(
    installationId: number,
    data: InstallationData,
    extra: { suspended?: boolean; orgId?: string } = {},
  ) {
    await ctx.db.system
      .insert(s.githubInstallations)
      .values({ installationId, sealed: seal(data), ...extra })
      .onConflictDoUpdate({
        target: s.githubInstallations.installationId,
        set: { sealed: seal(data), updatedAt: new Date(), ...extra },
      });
  }

  async function installationData(installationId: number): Promise<InstallationData | null> {
    const [row] = await ctx.db.system
      .select()
      .from(s.githubInstallations)
      .where(eq(s.githubInstallations.installationId, installationId));
    return row ? open(row.sealed) : null;
  }

  /** A pull request's head commit: Scan it, then Link in PR mode into its check run. */
  async function checkCommit(
    github: GithubApp,
    input: {
      installationId: number;
      repo: string;
      headSha: string;
      baseSha: string | null;
      prNumber: number | null;
    },
  ): Promise<string[]> {
    const projects = await projectsFor(input.installationId, input.repo);
    const [owner, name] = input.repo.split("/") as [string, string];
    if (projects.length === 0) return [];
    const changed = input.baseSha
      ? await github.changedFiles(input.installationId, owner, name, input.baseSha, input.headSha)
      : [];
    const started: string[] = [];
    for (const project of projects) {
      if (!ctx.store) continue;
      const snapshot = await ctx.db.withOrg(project.orgId, (tx) =>
        createSnapshot(tx, {
          orgId: project.orgId,
          projectId: project.id,
          kind: "github",
          sourceUrl: input.repo,
          ref: input.headSha,
          githubInstallationId: input.installationId,
        }),
      );
      const children: ChildRun[] = [
        {
          job: "scan.incremental",
          run: { type: "scan", snapshotId: snapshot.id, steps: ScanStage.options },
        },
      ];
      const { linkRunId } = await startLinked(ctx, {
        orgId: project.orgId,
        projectId: project.id,
        userId: null,
        trigger: "webhook",
        children,
        linkOutcome: { mode: "pr", changed_files: changed, head_sha: input.headSha },
        onCreated: (tx, linkId, [scanRunId]) =>
          upsertCheckRow(tx, {
            orgId: project.orgId,
            projectId: project.id,
            repo: input.repo,
            headSha: input.headSha,
            baseSha: input.baseSha,
            prNumber: input.prNumber,
            installationId: input.installationId,
            changedFiles: changed,
            scanRunId: scanRunId ?? null,
            linkRunId: linkId,
          }),
      });
      await markInProgress(github, project.orgId, project.id, input.headSha, linkRunId);
      started.push(linkRunId);
    }
    return started;
  }

  async function upsertCheckRow(
    tx: Parameters<NonNullable<Parameters<typeof startLinked>[1]["onCreated"]>>[0],
    row: typeof s.githubCheckRuns.$inferInsert,
  ) {
    await tx
      .insert(s.githubCheckRuns)
      .values(row)
      .onConflictDoUpdate({
        target: [s.githubCheckRuns.projectId, s.githubCheckRuns.headSha],
        set: {
          linkRunId: row.linkRunId,
          updatedAt: new Date(),
          ...(row.scanRunId ? { scanRunId: row.scanRunId } : {}),
          ...(row.baseSha ? { baseSha: row.baseSha, changedFiles: row.changedFiles } : {}),
          ...(row.prNumber ? { prNumber: row.prNumber } : {}),
        },
      });
  }

  /** Shows the check as running on GitHub; Link completes it. A failure is not fatal. */
  async function markInProgress(
    github: GithubApp,
    orgId: string,
    projectId: string,
    headSha: string,
    linkRunId: string,
  ) {
    const [row] = await ctx.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(s.githubCheckRuns)
        .where(
          and(eq(s.githubCheckRuns.projectId, projectId), eq(s.githubCheckRuns.headSha, headSha)),
        ),
    );
    if (!row) return;
    const [owner, repo] = row.repo.split("/") as [string, string];
    const body = {
      status: "in_progress" as const,
      details_url: `${ctx.config.PUBLIC_APP_URL}/runs/${linkRunId}`,
      output: { title: "Checking…", summary: "CodeSentra is checking this commit." },
    };
    try {
      if (row.checkRunId)
        await github.updateCheckRun(row.installationId, owner, repo, row.checkRunId, body);
      else {
        const created = await github.createCheckRun(row.installationId, owner, repo, {
          name: "CodeSentra",
          head_sha: headSha,
          ...body,
        });
        await ctx.db.withOrg(orgId, (tx) =>
          tx
            .update(s.githubCheckRuns)
            .set({ checkRunId: created.id })
            .where(eq(s.githubCheckRuns.id, row.id)),
        );
      }
    } catch {
      // Link creates the check run when it completes if this did not.
    }
  }

  async function onPullRequest(github: GithubApp, payload: unknown): Promise<Handled> {
    const e = PullRequestEvent.parse(payload);
    if (!["opened", "synchronize", "reopened"].includes(e.action))
      return { status: "ignored", detail: `pull_request.${e.action}` };
    const runs = await checkCommit(github, {
      installationId: e.installation.id,
      repo: e.repository.full_name,
      headSha: e.pull_request.head.sha,
      baseSha: e.pull_request.base.sha,
      prNumber: e.number,
    });
    return runs.length
      ? { status: "processed", detail: `link runs ${runs.join(",")}` }
      : { status: "ignored", detail: "no project is bound to this repository" };
  }

  async function onDeploymentStatus(github: GithubApp, payload: unknown): Promise<Handled> {
    const e = DeploymentStatusEvent.parse(payload);
    const target = e.deployment_status.environment_url ?? e.deployment_status.target_url;
    if (e.deployment_status.state !== "success" || !target)
      return { status: "ignored", detail: `deployment_status.${e.deployment_status.state}` };
    const production =
      /^production$/i.test(e.deployment.environment) ||
      (e.deployment as { production_environment?: boolean }).production_environment === true;
    const projects = await projectsFor(e.installation.id, e.repository.full_name);
    const testAllow = testAllowHosts(ctx);
    const started: string[] = [];
    for (const project of projects) {
      try {
        assertPublicTarget(target, testAllow);
      } catch (err) {
        return { status: "ignored", detail: `target_url refused: ${(err as Error).message}` };
      }
      const { env, row } = await ctx.db.withOrg(project.orgId, async (tx) => {
        const envs = await tx
          .select()
          .from(s.environments)
          .where(eq(s.environments.projectId, project.id));
        const [row] = await tx
          .select()
          .from(s.githubCheckRuns)
          .where(
            and(
              eq(s.githubCheckRuns.projectId, project.id),
              eq(s.githubCheckRuns.headSha, e.deployment.sha),
            ),
          );
        const env =
          envs.find((x) => x.name.toLowerCase() === e.deployment.environment.toLowerCase()) ?? null;
        return { env, row: row ?? null };
      });
      const children: ChildRun[] = [
        {
          job: "pulse.run",
          run: {
            type: "pulse",
            environmentId: production ? (env?.id ?? null) : null,
            targetUrl: target,
            steps: PULSE_GROUPS,
          },
        },
      ];
      const changed = row?.changedFiles ?? [];
      const { linkRunId } = await startLinked(ctx, {
        orgId: project.orgId,
        projectId: project.id,
        userId: null,
        trigger: "webhook",
        children,
        // Production deployments update the project's issues; any other environment is a
        // preview of a branch and only reports into its commit's check run (ADR 0021).
        linkOutcome: production
          ? { mode: "sync", head_sha: e.deployment.sha }
          : { mode: "pr", changed_files: changed, head_sha: e.deployment.sha },
        onCreated: (tx, linkId) =>
          upsertCheckRow(tx, {
            orgId: project.orgId,
            projectId: project.id,
            repo: e.repository.full_name,
            headSha: e.deployment.sha,
            installationId: e.installation.id,
            linkRunId: linkId,
          }),
      });
      await markInProgress(github, project.orgId, project.id, e.deployment.sha, linkRunId);
      started.push(linkRunId);
    }
    return started.length
      ? { status: "processed", detail: `link runs ${started.join(",")}` }
      : { status: "ignored", detail: "no project is bound to this repository" };
  }

  async function onPush(github: GithubApp, payload: unknown): Promise<Handled> {
    const e = PushEvent.parse(payload);
    const branch = e.ref.replace(/^refs\/heads\//, "");
    if (e.deleted || !e.ref.startsWith("refs/heads/"))
      return { status: "ignored", detail: "not a branch update" };
    const projects = (await projectsFor(e.installation.id, e.repository.full_name)).filter(
      (p) => p.checkOnPush && branch === (p.defaultBranch ?? e.repository.default_branch),
    );
    const started: string[] = [];
    for (const project of projects) {
      if (!ctx.store) continue;
      const snapshot = await ctx.db.withOrg(project.orgId, (tx) =>
        createSnapshot(tx, {
          orgId: project.orgId,
          projectId: project.id,
          kind: "github",
          sourceUrl: e.repository.full_name,
          ref: e.after,
          githubInstallationId: e.installation.id,
        }),
      );
      const envs = await ctx.db.withOrg(project.orgId, (tx) =>
        tx.select().from(s.environments).where(eq(s.environments.projectId, project.id)),
      );
      const testAllow = testAllowHosts(ctx);
      const children: ChildRun[] = [
        {
          job: "scan.run",
          run: { type: "scan", snapshotId: snapshot.id, steps: ScanStage.options },
        },
        ...envs.flatMap((env): ChildRun[] => {
          try {
            assertPublicTarget(env.url, testAllow);
          } catch {
            return [];
          }
          return [
            {
              job: "pulse.run",
              run: {
                type: "pulse",
                environmentId: env.id,
                targetUrl: env.url,
                steps: PULSE_GROUPS,
              },
            },
          ];
        }),
      ];
      // A default-branch push is a full check that updates the project's issues.
      const { linkRunId } = await startLinked(ctx, {
        orgId: project.orgId,
        projectId: project.id,
        userId: null,
        trigger: "webhook",
        children,
        linkOutcome: { mode: "sync", head_sha: e.after },
        onCreated: (tx, linkId, [scanRunId]) =>
          upsertCheckRow(tx, {
            orgId: project.orgId,
            projectId: project.id,
            repo: e.repository.full_name,
            headSha: e.after,
            installationId: e.installation.id,
            scanRunId: scanRunId ?? null,
            linkRunId: linkId,
          }),
      });
      await markInProgress(github, project.orgId, project.id, e.after, linkRunId);
      started.push(linkRunId);
    }
    return started.length
      ? { status: "processed", detail: `link runs ${started.join(",")}` }
      : { status: "ignored", detail: "no project checks pushes to this branch" };
  }

  async function onInstallation(payload: unknown): Promise<Handled> {
    const e = InstallationEvent.parse(payload);
    const id = e.installation.id;
    if (e.action === "deleted") {
      await ctx.db.system
        .update(s.githubInstallations)
        .set({ suspended: true, orgId: null, updatedAt: new Date() })
        .where(eq(s.githubInstallations.installationId, id));
      return { status: "processed", detail: "installation removed and unlinked" };
    }
    await upsertInstallation(
      id,
      {
        account: e.installation.account.login,
        repositories: (e.repositories ?? []).map((r) => r.full_name),
      },
      { suspended: e.action === "suspend" },
    );
    return { status: "processed", detail: `installation.${e.action}` };
  }

  async function onInstallationRepositories(payload: unknown): Promise<Handled> {
    const e = InstallationRepositoriesEvent.parse(payload);
    const current = (await installationData(e.installation.id)) ?? {
      account: null,
      repositories: [],
    };
    const removed = new Set(e.repositories_removed.map((r) => r.full_name));
    const repositories = [
      ...new Set([...current.repositories, ...e.repositories_added.map((r) => r.full_name)]),
    ].filter((r) => !removed.has(r));
    await upsertInstallation(e.installation.id, { ...current, repositories });
    return { status: "processed", detail: `${repositories.length} repositories` };
  }

  return async (app) => {
    app.post(
      "/v1/webhooks/github",
      {
        bodyLimit: 26 * 1024 * 1024,
        config: { rateLimit: { max: 3000, timeWindow: "1 minute" } },
        schema: {
          tags: ["github"],
          summary: "GitHub App webhooks",
          description:
            "Signed with GITHUB_WEBHOOK_SECRET (X-Hub-Signature-256) and deduplicated by X-GitHub-Delivery: a replayed delivery is acknowledged and does nothing. Handles installation, installation_repositories, pull_request (opened/synchronize/reopened), deployment_status (success) and push.",
          security: [],
          response: {
            200: z.object({
              status: z.enum(["processed", "ignored", "duplicate"]),
              detail: z.string(),
            }),
            400: Problem,
            401: Problem,
            501: Problem,
          },
        },
      },
      async (req) => {
        const github = configured();
        const raw = rawBodyOf(req);
        const sig = req.headers["x-hub-signature-256"];
        if (
          raw === undefined ||
          !verifyWebhookSignature(
            ctx.config.GITHUB_WEBHOOK_SECRET as string,
            Buffer.from(raw, "utf8"),
            typeof sig === "string" ? sig : undefined,
          )
        )
          throw unauthorized();
        const event = String(req.headers["x-github-event"] ?? "");
        const deliveryId = String(req.headers["x-github-delivery"] ?? "");
        if (!/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) || !event)
          throw badRequest("X-GitHub-Delivery and X-GitHub-Event are required");
        const inserted = await ctx.db.system
          .insert(s.webhookDeliveries)
          .values({ provider: "github", deliveryId, event, status: "received" })
          .onConflictDoNothing()
          .returning({ id: s.webhookDeliveries.id });
        if (inserted.length === 0)
          return { status: "duplicate" as const, detail: "this delivery was already received" };
        const record = (h: Handled | { status: "failed"; detail: string }) =>
          ctx.db.system
            .update(s.webhookDeliveries)
            .set({ status: h.status, detail: h.detail.slice(0, 2000), updatedAt: new Date() })
            .where(eq(s.webhookDeliveries.deliveryId, deliveryId));
        try {
          const handlers: Record<string, (p: unknown) => Promise<Handled>> = {
            installation: onInstallation,
            installation_repositories: onInstallationRepositories,
            pull_request: (p) => onPullRequest(github, p),
            deployment_status: (p) => onDeploymentStatus(github, p),
            push: (p) => onPush(github, p),
          };
          const handle = handlers[event];
          const result = handle
            ? await handle(req.body)
            : { status: "ignored" as const, detail: `event ${event} is not used` };
          await record(result);
          return result;
        } catch (err) {
          await record({ status: "failed", detail: (err as Error).message });
          if (err instanceof z.ZodError) throw badRequest(`Unexpected ${event} payload`);
          throw err;
        }
      },
    );

    app.get(
      "/v1/github/install",
      {
        schema: {
          tags: ["github"],
          summary: "Install the GitHub App for an organization",
          description:
            "Redirects an org admin to GitHub to install the App. The signed state ties the installation back to this org and user; GitHub's setup redirect returns to /v1/github/setup.",
          querystring: z.object({ org_id: z.uuid() }),
          response: { 302: z.null(), 401: Problem, 403: Problem, 404: Problem, 501: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireOrg(req, req.query.org_id, "admin");
        configured();
        if (!ctx.config.GITHUB_APP_SLUG)
          throw notConfigured("Installing the GitHub App", "GITHUB_APP_SLUG");
        const state = sign(
          { org: access.orgId, user: access.user.id, exp: Date.now() + STATE_TTL_MS },
          ctx.config.SESSION_SECRET,
        );
        const u = new URL(
          `/apps/${encodeURIComponent(ctx.config.GITHUB_APP_SLUG)}/installations/new`,
          ctx.config.GITHUB_OAUTH_BASE_URL,
        );
        u.searchParams.set("state", state);
        return reply.redirect(u.toString(), 302);
      },
    );

    app.get(
      "/v1/github/setup",
      {
        schema: {
          tags: ["github"],
          summary: "GitHub App setup callback",
          description:
            "GitHub redirects here after installation. installation_id is not trusted: the user-authorization code must show that this user can access the installation, and the signed state must name an org they administer.",
          querystring: z.object({
            installation_id: z.coerce.number().int().positive(),
            setup_action: z.string().max(40).optional(),
            state: z.string().max(2000),
            code: z.string().max(512),
          }),
          response: {
            302: z.null(),
            400: Problem,
            401: Problem,
            403: Problem,
            404: Problem,
            409: Problem,
            501: Problem,
          },
        },
      },
      async (req, reply) => {
        const github = configured();
        const user = requireUser(req);
        const st = verify<InstallState>(req.query.state, ctx.config.SESSION_SECRET);
        if (!st || st.exp < Date.now() || st.user !== user.id)
          throw badRequest("The install link expired or belongs to another session; start again");
        await ctx.authz.requireOrg(req, st.org, "admin");
        let allowed = false;
        try {
          allowed = await github.userCanAccessInstallation(
            req.query.code,
            req.query.installation_id,
          );
        } catch (e) {
          throw new HttpError(502, "github_failed", "GitHub request failed", (e as Error).message);
        }
        if (!allowed) throw badRequest("Your GitHub account cannot access that installation");
        const [existing] = await ctx.db.system
          .select()
          .from(s.githubInstallations)
          .where(eq(s.githubInstallations.installationId, req.query.installation_id));
        if (existing?.orgId && existing.orgId !== st.org)
          throw conflict("This installation is already linked to another organization");
        if (existing)
          await ctx.db.system
            .update(s.githubInstallations)
            .set({ orgId: st.org, suspended: false, updatedAt: new Date() })
            .where(eq(s.githubInstallations.id, existing.id));
        else
          await upsertInstallation(
            req.query.installation_id,
            { account: null, repositories: [] },
            { orgId: st.org },
          );
        return reply.redirect(`${ctx.config.PUBLIC_APP_URL}/settings?github=linked`, 302);
      },
    );

    app.get(
      "/v1/orgs/:id/github/installations",
      {
        schema: {
          tags: ["github"],
          summary: "GitHub installations linked to the organization",
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              configured: z.boolean(),
              installations: z.array(
                z.object({
                  installation_id: z.number().int(),
                  account: z.string().nullable(),
                  repositories: z.array(z.string()),
                  suspended: z.boolean(),
                }),
              ),
            }),
            401: Problem,
            404: Problem,
          },
        },
      },
      async (req) => {
        const { orgId } = await ctx.authz.requireOrg(req, req.params.id);
        const rows = await ctx.db.withOrg(orgId, (tx) => tx.select().from(s.githubInstallations));
        return {
          configured: Boolean(ctx.config.integrations.github_app && ctx.github),
          installations: rows.map((r) => {
            const d = open(r.sealed);
            return {
              installation_id: r.installationId,
              account: d.account,
              repositories: d.repositories,
              suspended: r.suspended,
            };
          }),
        };
      },
    );
  };
}
