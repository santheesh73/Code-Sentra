import { CronError, minCronIntervalMinutes, nextCronRun } from "@codesentra/core";
import { schema as s } from "@codesentra/db";
import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { badRequest, notFound, Problem } from "../errors.js";
import { assertPublicTarget } from "./pulse.js";
import { testAllowHosts } from "./scan.js";

/** A recurring Pulse may run at most every 5 minutes (Section 17: per-run-type limits). */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5;
export const MAX_SCHEDULES_PER_PROJECT = 10;

export const ScheduleDto = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    environment_id: z.uuid(),
    cron: z.string().describe("Five fields, UTC"),
    run_type: z.literal("pulse"),
    enabled: z.boolean(),
    next_run_at: z.iso.datetime(),
    last_run_id: z.uuid().nullable().describe("The Link run the last firing started"),
    last_run_at: z.iso.datetime().nullable(),
    last_error: z.string().nullable(),
    created_at: z.iso.datetime(),
  })
  .meta({ id: "Schedule" });

type Row = typeof s.schedules.$inferSelect;
const dto = (r: Row): z.infer<typeof ScheduleDto> => ({
  id: r.id,
  project_id: r.projectId,
  environment_id: r.environmentId,
  cron: r.cron,
  run_type: "pulse",
  enabled: r.enabled,
  next_run_at: r.nextRunAt.toISOString(),
  last_run_id: r.lastRunId,
  last_run_at: r.lastRunAt?.toISOString() ?? null,
  last_error: r.lastError,
  created_at: r.createdAt.toISOString(),
});

export function scheduleRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const testAllow = testAllowHosts(ctx);

    app.post(
      "/v1/projects/:id/schedules",
      {
        schema: {
          tags: ["schedules"],
          summary: "Create a recurring Pulse",
          description: `Runs Pulse (then Link) on the environment whenever the five-field UTC cron matches, at most every ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes. worker-link fires due schedules; a missed window is not replayed.`,
          params: z.object({ id: z.uuid() }),
          body: z.object({
            environment_id: z.uuid(),
            cron: z.string().trim().min(9).max(100),
            enabled: z.boolean().default(true),
          }),
          response: { 201: ScheduleDto, 400: Problem, 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        let next: Date;
        try {
          next = nextCronRun(req.body.cron, new Date());
          const gap = minCronIntervalMinutes(req.body.cron, new Date());
          if (gap < MIN_SCHEDULE_INTERVAL_MINUTES)
            throw badRequest(
              `The schedule fires every ${gap} minute(s); the minimum is ${MIN_SCHEDULE_INTERVAL_MINUTES}`,
            );
        } catch (e) {
          if (e instanceof CronError) throw badRequest(`Invalid cron: ${e.message}`);
          throw e;
        }
        const row = await ctx.db.withOrg(access.orgId, async (tx) => {
          const [env] = await tx
            .select()
            .from(s.environments)
            .where(
              and(
                eq(s.environments.id, req.body.environment_id),
                eq(s.environments.projectId, req.params.id),
              ),
            );
          if (!env) throw notFound("Environment");
          assertPublicTarget(env.url, testAllow);
          const [{ n }] = (await tx
            .select({ n: count() })
            .from(s.schedules)
            .where(eq(s.schedules.projectId, req.params.id))) as [{ n: number }];
          if (n >= MAX_SCHEDULES_PER_PROJECT)
            throw badRequest(`A project can have at most ${MAX_SCHEDULES_PER_PROJECT} schedules`);
          const [row] = await tx
            .insert(s.schedules)
            .values({
              orgId: access.orgId,
              projectId: req.params.id,
              environmentId: env.id,
              cron: req.body.cron.replace(/\s+/g, " "),
              enabled: req.body.enabled,
              nextRunAt: next,
              createdBy: access.user.id,
            })
            .returning();
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "schedule.created",
            target: `schedule:${row?.id}`,
            metadata: { cron: row?.cron, environment_id: env.id },
          });
          return row as Row;
        });
        return reply.code(201).send(dto(row));
      },
    );

    app.get(
      "/v1/projects/:id/schedules",
      {
        schema: {
          tags: ["schedules"],
          summary: "List schedules",
          params: z.object({ id: z.uuid() }),
          response: { 200: z.array(ScheduleDto), 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const { orgId } = await ctx.authz.requireProject(req, req.params.id);
        const rows = await ctx.db.withOrg(orgId, (tx) =>
          tx
            .select()
            .from(s.schedules)
            .where(eq(s.schedules.projectId, req.params.id))
            .orderBy(desc(s.schedules.createdAt)),
        );
        return rows.map(dto);
      },
    );

    app.delete(
      "/v1/projects/:id/schedules",
      {
        schema: {
          tags: ["schedules"],
          summary: "Delete a schedule",
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ schedule_id: z.uuid() }),
          response: { 204: z.null(), 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        await ctx.db.withOrg(access.orgId, async (tx) => {
          const deleted = await tx
            .delete(s.schedules)
            .where(
              and(
                eq(s.schedules.id, req.query.schedule_id),
                eq(s.schedules.projectId, req.params.id),
              ),
            )
            .returning({ id: s.schedules.id });
          if (deleted.length === 0) throw notFound("Schedule");
          await tx.insert(s.auditLog).values({
            orgId: access.orgId,
            actorId: access.user.id,
            action: "schedule.deleted",
            target: `schedule:${req.query.schedule_id}`,
          });
        });
        return reply.code(204).send(null);
      },
    );
  };
}
