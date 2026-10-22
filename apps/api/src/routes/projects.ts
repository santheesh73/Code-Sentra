import { countOpenIssues, createRun, failRun, schema as s, type TenantTx } from "@codesentra/db";
import { DIAGNOSTIC_STEPS, publishRunEvent } from "@codesentra/queue";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  EnvironmentDto,
  environmentDto,
  ProjectDto,
  PublicHttpUrl,
  projectDto,
  RunAccepted,
  RunSummaryDto,
  runSummaryDto,
} from "../dto.js";
import { conflict, notFound, Problem } from "../errors.js";

const ProjectParams = z.object({ id: z.uuid() });
const EnvInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  url: PublicHttpUrl,
});

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}

async function loadProjects(tx: TenantTx, ids?: string[]) {
  const projects = await tx
    .select()
    .from(s.projects)
    .where(ids ? inArray(s.projects.id, ids) : undefined)
    .orderBy(asc(s.projects.createdAt));
  if (projects.length === 0) return [];
  const pids = projects.map((p) => p.id);
  const envs = await tx
    .select()
    .from(s.environments)
    .where(inArray(s.environments.projectId, pids))
    .orderBy(asc(s.environments.createdAt));
  const latest = await tx
    .selectDistinctOn([s.runs.projectId])
    .from(s.runs)
    .where(inArray(s.runs.projectId, pids))
    .orderBy(s.runs.projectId, desc(s.runs.createdAt));
  // Latest finished Pulse per environment: the environment's status badge.
  const envIds = envs.map((e) => e.id);
  const pulses = envIds.length
    ? await tx
        .selectDistinctOn([s.runs.environmentId])
        .from(s.runs)
        .where(
          and(
            inArray(s.runs.environmentId, envIds),
            eq(s.runs.type, "pulse"),
            isNotNull(s.runs.outcome),
          ),
        )
        .orderBy(s.runs.environmentId, desc(s.runs.createdAt))
    : [];
  const pulseByEnv = new Map(pulses.map((r) => [r.environmentId as string, r]));
  const scans = await tx
    .selectDistinctOn([s.runs.projectId])
    .from(s.runs)
    .where(
      and(inArray(s.runs.projectId, pids), eq(s.runs.type, "scan"), isNotNull(s.runs.finishedAt)),
    )
    .orderBy(s.runs.projectId, desc(s.runs.createdAt));
  const openIssues = await countOpenIssues(tx, pids);
  return projects.map((p) =>
    projectDto(
      p,
      envs.filter((e) => e.projectId === p.id),
      latest.find((r) => r.projectId === p.id) ?? null,
      pulseByEnv,
      openIssues.get(p.id) ?? 0,
      scans.find((r) => r.projectId === p.id) ?? null,
    ),
  );
}

export function projectRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/projects",
      {
        schema: {
          tags: ["projects"],
          summary: "Create a project with an optional repository and deploy URLs",
          body: z.object({
            org_id: z.uuid(),
            name: z.string().trim().min(1).max(100),
            repo_url: PublicHttpUrl.optional(),
            default_branch: z.string().trim().min(1).max(255).optional(),
            environments: z.array(EnvInput).max(10).default([]),
          }),
          response: { 201: ProjectDto, 400: Problem, 401: Problem, 404: Problem, 409: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireOrg(req, req.body.org_id);
        const names = req.body.environments.map((e) => e.name);
        if (new Set(names).size !== names.length)
          throw conflict("Environment names must be unique");
        const dto = await ctx.db.withOrg(access.orgId, async (tx) => {
          const [p] = await tx
            .insert(s.projects)
            .values({
              orgId: access.orgId,
              name: req.body.name,
              repoUrl: req.body.repo_url ?? null,
              defaultBranch: req.body.default_branch ?? null,
            })
            .returning();
          if (!p) throw new Error("project insert failed");
          if (req.body.environments.length > 0) {
            await tx.insert(s.environments).values(
              req.body.environments.map((e) => ({
                orgId: access.orgId,
                projectId: p.id,
                name: e.name,
                url: e.url,
              })),
            );
          }
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "project.created",
            target: `project:${p.id}`,
          });
          const [out] = await loadProjects(tx, [p.id]);
          if (!out) throw new Error("created project not readable");
          return out;
        });
        return reply.code(201).send(dto);
      },
    );

    app.get(
      "/v1/projects",
      {
        schema: {
          tags: ["projects"],
          summary: "Projects in an organization",
          querystring: z.object({ org_id: z.uuid() }),
          response: { 200: z.array(ProjectDto), 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireOrg(req, req.query.org_id);
        return ctx.db.withOrg(access.orgId, (tx) => loadProjects(tx));
      },
    );

    app.get(
      "/v1/projects/:id",
      {
        schema: {
          tags: ["projects"],
          summary: "One project",
          params: ProjectParams,
          response: { 200: ProjectDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const [dto] = await ctx.db.withOrg(access.orgId, (tx) => loadProjects(tx, [req.params.id]));
        if (!dto) throw notFound("Project");
        return dto;
      },
    );

    app.patch(
      "/v1/projects/:id",
      {
        schema: {
          tags: ["projects"],
          summary: "Update a project",
          params: ProjectParams,
          body: z
            .object({
              name: z.string().trim().min(1).max(100),
              repo_url: PublicHttpUrl.nullable(),
              default_branch: z.string().trim().min(1).max(255).nullable(),
              github_repo: z
                .string()
                .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "owner/repo")
                .nullable()
                .describe(
                  "The repository this project follows through the org's GitHub App installation",
                ),
              check_on_push: z
                .boolean()
                .describe("Run a full check on every push to the default branch"),
            })
            .partial(),
          response: { 200: ProjectDto, 401: Problem, 404: Problem, 409: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        return ctx.db.withOrg(access.orgId, async (tx) => {
          const set: Partial<typeof s.projects.$inferInsert> = {};
          if (req.body.name !== undefined) set.name = req.body.name;
          if (req.body.repo_url !== undefined) set.repoUrl = req.body.repo_url;
          if (req.body.default_branch !== undefined) set.defaultBranch = req.body.default_branch;
          if (req.body.github_repo !== undefined) set.githubRepo = req.body.github_repo;
          if (req.body.check_on_push !== undefined) set.checkOnPush = req.body.check_on_push;
          if (Object.keys(set).length > 0) {
            try {
              await tx.update(s.projects).set(set).where(eq(s.projects.id, req.params.id));
            } catch (e) {
              if (isUniqueViolation(e))
                throw conflict(
                  "Another project of this organization already follows that repository",
                );
              throw e;
            }
          }
          const [dto] = await loadProjects(tx, [req.params.id]);
          if (!dto) throw notFound("Project");
          return dto;
        });
      },
    );

    app.delete(
      "/v1/projects/:id",
      {
        schema: {
          tags: ["projects"],
          summary: "Delete a project and its runs (admin or owner)",
          params: ProjectParams,
          response: { 204: z.null(), 401: Problem, 403: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id, "admin");
        await ctx.db.withOrg(access.orgId, async (tx) => {
          const [p] = await tx
            .delete(s.projects)
            .where(eq(s.projects.id, req.params.id))
            .returning();
          if (!p) throw notFound("Project");
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "project.deleted",
            target: `project:${p.id}`,
            metadata: { name: p.name },
          });
        });
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/v1/projects/:id/environments",
      {
        schema: {
          tags: ["projects"],
          summary: "Add a deploy URL",
          params: ProjectParams,
          body: EnvInput,
          response: { 201: EnvironmentDto, 400: Problem, 401: Problem, 404: Problem, 409: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        try {
          const env = await ctx.db.withOrg(access.orgId, async (tx) => {
            const [e] = await tx
              .insert(s.environments)
              .values({
                orgId: access.orgId,
                projectId: req.params.id,
                name: req.body.name,
                url: req.body.url,
              })
              .returning();
            if (!e) throw new Error("environment insert returned no row");
            return e;
          });
          return reply.code(201).send(environmentDto(env));
        } catch (e) {
          if (isUniqueViolation(e))
            throw conflict(`An environment named ${req.body.name} already exists`);
          throw e;
        }
      },
    );

    app.get(
      "/v1/projects/:id/runs",
      {
        schema: {
          tags: ["runs"],
          summary: "Recent runs for a project",
          params: ProjectParams,
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
          response: { 200: z.array(RunSummaryDto), 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const rows = await ctx.db.withOrg(access.orgId, (tx) =>
          tx
            .select()
            .from(s.runs)
            .where(and(eq(s.runs.projectId, req.params.id)))
            .orderBy(desc(s.runs.createdAt))
            .limit(req.query.limit),
        );
        return rows.map(runSummaryDto);
      },
    );

    app.post(
      "/v1/projects/:id/diagnostic",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["runs"],
          summary: "Run a platform diagnostic (database, queue, object storage)",
          description:
            "Verifies the CodeSentra pipeline end to end for this project's organization. Watch it with GET /v1/runs/{id}/stream.",
          params: ProjectParams,
          response: { 202: RunAccepted, 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const { run } = await ctx.db.withOrg(access.orgId, async (tx) => {
          const created = await createRun(tx, {
            orgId: access.orgId,
            projectId: req.params.id,
            type: "diagnostic",
            trigger: "manual",
            requestedBy: access.user.id,
            steps: DIAGNOSTIC_STEPS,
          });
          await publishRunEvent(tx, {
            kind: "run",
            runId: created.run.id,
            orgId: access.orgId,
            status: "queued",
          });
          return created;
        });
        try {
          await ctx.queue.enqueue("system.diagnostic", { runId: run.id, orgId: access.orgId });
        } catch (e) {
          await ctx.db.withOrg(access.orgId, (tx) =>
            failRun(tx, run.id, `could not enqueue: ${(e as Error).message}`),
          );
          throw e;
        }
        return reply.code(202).send({ run_id: run.id });
      },
    );
  };
}
