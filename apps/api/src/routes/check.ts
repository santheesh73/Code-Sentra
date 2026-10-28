import { PULSE_GROUPS } from "@codesentra/checks";
import { type RecheckSpec, ScanStage } from "@codesentra/core";
import { schema as s } from "@codesentra/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { RunAccepted } from "../dto.js";
import { badRequest, notFound, Problem } from "../errors.js";
import { type ChildRun, startLinked } from "../orchestrate.js";
import { assertPublicTarget } from "./pulse.js";
import { projectSourceSnapshot, testAllowHosts } from "./scan.js";

export function checkRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const testAllow = testAllowHosts(ctx);

    app.post(
      "/v1/projects/:id/check",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          tags: ["link"],
          summary: "Full check: Scan + Pulse in parallel, then Link",
          description:
            "Scans the given snapshot (else the project's GitHub repository at its default branch when the GitHub App covers it, else its repo_url, else its latest uploaded snapshot) and runs Pulse on every environment (or the one given), in parallel. When both finish, a Link run traces each issue to code, writes its prompt and re-checks earlier issues. Returns the Link run. A module that cannot run (no snapshot, no environment, no object storage) is a gap of the Link run.",
          params: z.object({ id: z.uuid() }),
          body: z
            .object({ snapshot_id: z.uuid().optional(), environment_id: z.uuid().optional() })
            .optional(),
          response: { 202: RunAccepted, 400: Problem, 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const { orgId } = access;
        const { project, envs, snapshot } = await ctx.db.withOrg(orgId, async (tx) => {
          const [project] = await tx
            .select()
            .from(s.projects)
            .where(eq(s.projects.id, req.params.id));
          const envs = await tx
            .select()
            .from(s.environments)
            .where(eq(s.environments.projectId, req.params.id));
          const wanted = req.body?.snapshot_id;
          const [snapshot] = wanted
            ? await tx
                .select()
                .from(s.snapshots)
                .where(and(eq(s.snapshots.id, wanted), eq(s.snapshots.projectId, req.params.id)))
            : await tx
                .select()
                .from(s.snapshots)
                .where(
                  and(eq(s.snapshots.projectId, req.params.id), isNotNull(s.snapshots.storageKey)),
                )
                .orderBy(desc(s.snapshots.createdAt))
                .limit(1);
          return { project, envs, snapshot: snapshot ?? null };
        });
        if (!project) throw notFound("Project");
        if (req.body?.snapshot_id && !snapshot) throw notFound("Snapshot");
        const targets = req.body?.environment_id
          ? envs.filter((e) => e.id === req.body?.environment_id)
          : envs;
        if (req.body?.environment_id && targets.length === 0) throw notFound("Environment");

        const children: ChildRun[] = [];
        // Scan: the given snapshot, a fresh clone of repo_url, or the latest upload.
        if (ctx.store) {
          let snapshotId: string | null = req.body?.snapshot_id ? (snapshot?.id ?? null) : null;
          if (!snapshotId)
            snapshotId = (await projectSourceSnapshot(ctx, testAllow, project))?.id ?? null;
          snapshotId ??= snapshot?.id ?? null;
          if (snapshotId)
            children.push({
              job: "scan.run",
              run: { type: "scan", snapshotId, steps: ScanStage.options },
            });
        }
        for (const env of targets) {
          assertPublicTarget(env.url, testAllow);
          children.push({
            job: "pulse.run",
            run: { type: "pulse", environmentId: env.id, targetUrl: env.url, steps: PULSE_GROUPS },
          });
        }
        if (children.length === 0)
          throw badRequest(
            "Nothing to check: add a deploy URL, or upload a zip / set a repo_url to scan",
          );
        const started = await startLinked(ctx, {
          orgId,
          projectId: project.id,
          userId: access.user.id,
          trigger: req.tokenOrgId ? "cli" : "manual",
          children,
        });
        return reply.code(202).send({ run_id: started.linkRunId });
      },
    );

    app.post(
      "/v1/issues/:id/recheck",
      {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          tags: ["issues"],
          summary: "Targeted re-check",
          description:
            "Re-runs just the check group the issue's re-check names (Pulse: that group, after reachability and platform; Scan: a new Scan of the project's GitHub repository or repo_url), then Link re-evaluates the issue. Returns the Link run.",
          params: z.object({ id: z.uuid() }),
          response: { 202: RunAccepted, 400: Problem, 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireIssue(req, req.params.id);
        const { orgId } = access;
        const { issue, env, project } = await ctx.db.withOrg(orgId, async (tx) => {
          const [issue] = await tx.select().from(s.issues).where(eq(s.issues.id, req.params.id));
          const [env] = issue?.environmentId
            ? await tx
                .select()
                .from(s.environments)
                .where(eq(s.environments.id, issue.environmentId))
            : [];
          const [project] = issue
            ? await tx.select().from(s.projects).where(eq(s.projects.id, issue.projectId))
            : [];
          return { issue, env: env ?? null, project: project ?? null };
        });
        if (!issue || !project) throw notFound("Issue");
        if (issue.status === "dismissed")
          throw badRequest("The issue is dismissed; re-checks never change a dismissal");
        const recheck = issue.recheck as RecheckSpec;
        let child: ChildRun;
        if (recheck.module === "pulse") {
          if (!env) throw badRequest("The issue's environment no longer exists");
          assertPublicTarget(env.url, testAllow);
          child = {
            job: "issue.recheck",
            run: {
              type: "recheck",
              environmentId: env.id,
              targetUrl: env.url,
              steps: PULSE_GROUPS,
            },
            outcome: { recheck: { issue_id: issue.id, check_group: recheck.check_group } },
          };
        } else {
          const snap = ctx.store ? await projectSourceSnapshot(ctx, testAllow, project) : null;
          if (!snap)
            throw badRequest(
              "Scan issues are re-checked by a new Scan of the project's source: bind its GitHub repository, set its repo_url, or upload a new zip and scan it",
            );
          child = {
            job: "scan.run",
            run: { type: "scan", snapshotId: snap.id, steps: ScanStage.options },
          };
        }
        const started = await startLinked(ctx, {
          orgId,
          projectId: project.id,
          userId: access.user.id,
          trigger: req.tokenOrgId ? "cli" : "manual",
          children: [child],
        });
        return reply.code(202).send({ run_id: started.linkRunId });
      },
    );
  };
}
