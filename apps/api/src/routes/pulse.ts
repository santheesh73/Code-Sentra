import { PULSE_GROUPS } from "@codesentra/checks";
import { createRun, failRun, schema as s } from "@codesentra/db";
import { publishRunEvent } from "@codesentra/queue";
import { checkAddress, isIpLiteral } from "@codesentra/ssrf";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../authz.js";
import type { AppContext } from "../context.js";
import { PublicHttpUrl, RunAccepted } from "../dto.js";
import { badRequest, notFound, Problem } from "../errors.js";

const PROJECT_STEPS = [...PULSE_GROUPS, "issues"];

/**
 * Refuses obviously private targets up front (IP literals and localhost names). Names
 * that resolve privately are refused by the worker's SSRF guard and the run reports a
 * gap; nothing private is ever contacted either way.
 */
function assertPublicTarget(url: string, testAllowHosts: ReadonlySet<string>): void {
  const host = new URL(url).hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (testAllowHosts.has(host)) return;
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw badRequest("CodeSentra only checks public URLs; localhost is not reachable from here");
  }
  if (isIpLiteral(host)) {
    const v = checkAddress(host);
    if (!v.allowed) throw badRequest(`CodeSentra only checks public URLs (${v.reason})`);
  }
}

export function pulseRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    // Test only; packages/config refuses this setting unless NODE_ENV=test.
    const testAllow = new Set(
      (ctx.config.PULSE_TEST_ALLOW_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
    async function startPulse(input: {
      orgId: string;
      userId: string;
      projectId: string | null;
      environmentId: string | null;
      url: string;
      steps: readonly string[];
    }) {
      const { run } = await ctx.db.withOrg(input.orgId, async (tx) => {
        const created = await createRun(tx, {
          orgId: input.orgId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          type: "pulse",
          trigger: "manual",
          requestedBy: input.userId,
          targetUrl: input.url,
          steps: input.steps,
        });
        await publishRunEvent(tx, {
          kind: "run",
          runId: created.run.id,
          orgId: input.orgId,
          status: "queued",
        });
        return created;
      });
      try {
        await ctx.queue.enqueue("pulse.run", { runId: run.id, orgId: input.orgId });
      } catch (e) {
        await ctx.db.withOrg(input.orgId, (tx) =>
          failRun(tx, run.id, `could not enqueue: ${(e as Error).message}`),
        );
        throw e;
      }
      return run.id;
    }

    app.post(
      "/v1/projects/:id/pulse",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["pulse"],
          summary: "Start Sentra Pulse on an environment",
          description:
            "Checks the environment's deploy URL: reachability, platform, rendering, routes and hygiene. Findings become issues with fix prompts.",
          params: z.object({ id: z.uuid() }),
          body: z.object({ environment_id: z.uuid() }),
          response: { 202: RunAccepted, 400: Problem, 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const [env] = await ctx.db.withOrg(access.orgId, (tx) =>
          tx
            .select()
            .from(s.environments)
            .where(
              and(
                eq(s.environments.id, req.body.environment_id),
                eq(s.environments.projectId, req.params.id),
              ),
            ),
        );
        if (!env) throw notFound("Environment");
        assertPublicTarget(env.url, testAllow);
        const runId = await startPulse({
          orgId: access.orgId,
          userId: access.user.id,
          projectId: req.params.id,
          environmentId: env.id,
          url: env.url,
          steps: PROJECT_STEPS,
        });
        return reply.code(202).send({ run_id: runId });
      },
    );

    app.post(
      "/v1/pulse",
      {
        // Quick Pulse is limited per IP (Section 17).
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          tags: ["pulse"],
          summary: "Quick Pulse: check any public URL, no project needed",
          description:
            "The run belongs to the given organization; findings and fix prompts are returned by GET /v1/runs/{id}/findings. No issues are stored.",
          body: z.object({ url: PublicHttpUrl, org_id: z.uuid() }),
          response: { 202: RunAccepted, 400: Problem, 401: Problem, 404: Problem, 429: Problem },
        },
      },
      async (req, reply) => {
        requireUser(req);
        const access = await ctx.authz.requireOrg(req, req.body.org_id);
        assertPublicTarget(req.body.url, testAllow);
        const runId = await startPulse({
          orgId: access.orgId,
          userId: access.user.id,
          projectId: null,
          environmentId: null,
          url: req.body.url,
          steps: PULSE_GROUPS,
        });
        return reply.code(202).send({ run_id: runId });
      },
    );
  };
}
