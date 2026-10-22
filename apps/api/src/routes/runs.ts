import { isTerminalRunStatus } from "@codesentra/core";
import { childRuns, getRunWithSteps, type TenantTx } from "@codesentra/db";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { RunDto, runDto } from "../dto.js";
import { notFound, Problem } from "../errors.js";

const RunParams = z.object({ id: z.uuid() });
const HEARTBEAT_MS = 15_000;

async function loadRun(tx: TenantTx, id: string) {
  const run = await getRunWithSteps(tx, id);
  if (!run) return null;
  return { run, children: run.run.type === "link" ? await childRuns(tx, id) : [] };
}

export function runRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/v1/runs/:id",
      {
        schema: {
          tags: ["runs"],
          summary: "A run with its steps and coverage gaps",
          params: RunParams,
          response: { 200: RunDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireRun(req, req.params.id);
        const r = await ctx.db.withOrg(access.orgId, (tx) => loadRun(tx, req.params.id));
        if (!r) throw notFound("Run");
        return runDto(r.run, r.children);
      },
    );

    app.get(
      "/v1/runs/:id/stream",
      {
        schema: {
          tags: ["runs"],
          summary: "Live run progress (Server-Sent Events)",
          description:
            "Emits `run` events whose data is a full Run snapshot: one immediately, then one after every step or status change. The stream ends after the run reaches a terminal status. A `: ping` comment is sent every 15 s.",
          params: RunParams,
          response: { 200: z.string().describe("text/event-stream"), 401: Problem, 404: Problem },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireRun(req, req.params.id);
        const runId = req.params.id;
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        let closed = false;
        let chain = Promise.resolve();
        let off: (() => void) | null = null;
        const heartbeat = setInterval(() => {
          if (!closed) res.write(": ping\n\n");
        }, HEARTBEAT_MS);
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          off?.();
          res.end();
        };
        req.raw.on("close", close);

        const pushSnapshot = async () => {
          if (closed) return;
          const r = await ctx.db.withOrg(access.orgId, (tx) => loadRun(tx, runId));
          if (closed) return;
          if (!r) {
            res.write(`event: gone\ndata: {}\n\n`);
            close();
            return;
          }
          res.write(`event: run\ndata: ${JSON.stringify(runDto(r.run, r.children))}\n\n`);
          if (isTerminalRunStatus(r.run.run.status)) close();
        };
        const enqueue = () => {
          chain = chain.then(pushSnapshot).catch((e) => {
            req.log.error({ err: (e as Error).message }, "sse snapshot failed");
            close();
          });
        };
        // Subscribe before the first read so no change between the two is missed.
        off = ctx.events.subscribe(runId, enqueue);
        enqueue();
        await chain;
      },
    );
  };
}
