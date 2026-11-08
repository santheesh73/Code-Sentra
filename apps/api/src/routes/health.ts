import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";

const Check = z.enum(["ok", "error"]);
const ReadyCheck = z.enum(["ok", "error", "not_configured"]);
const Health = z.object({
  status: Check,
  checks: z.object({ database: Check, queue: Check }),
});
const Ready = z.object({
  status: Check,
  checks: z.object({ database: Check, queue: Check, storage: ReadyCheck }),
});

const probe = async (fn: () => Promise<unknown>) => {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
    return "ok" as const;
  } catch {
    return "error" as const;
  }
};

export function healthRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/health",
      {
        schema: {
          tags: ["health"],
          summary: "Liveness plus database and queue checks",
          response: { 200: Health, 503: Health },
        },
      },
      async (_req, reply) => {
        const [database, queue] = await Promise.all([
          probe(() => ctx.db.system.execute(sql`select 1`)),
          probe(async () => {
            if (!(await ctx.queue.boss.getQueue("system.diagnostic")))
              throw new Error("queue missing");
          }),
        ]);
        const ok = database === "ok" && queue === "ok";
        return reply
          .code(ok ? 200 : 503)
          .send({ status: ok ? "ok" : "error", checks: { database, queue } });
      },
    );

    // Readiness: can this instance serve traffic right now? Unlike /health (liveness), it
    // probes every backing dependency the API uses — database, queue and object storage —
    // so an orchestrator pulls the instance out of rotation when any one is unreachable.
    // Storage is reported not_configured only outside production, where Scan uploads answer
    // 501; in production the service refuses to start without it, so it is always probed.
    app.get(
      "/ready",
      {
        schema: {
          tags: ["health"],
          summary: "Readiness: database, queue and object storage are reachable",
          response: { 200: Ready, 503: Ready },
        },
      },
      async (_req, reply) => {
        const [database, queue, storage] = await Promise.all([
          probe(() => ctx.db.system.execute(sql`select 1`)),
          probe(async () => {
            if (!(await ctx.queue.boss.getQueue("system.diagnostic")))
              throw new Error("queue missing");
          }),
          ctx.store
            ? probe(() => (ctx.store as NonNullable<typeof ctx.store>).check())
            : Promise.resolve("not_configured" as const),
        ]);
        const ok = database === "ok" && queue === "ok" && storage !== "error";
        return reply
          .code(ok ? 200 : 503)
          .send({ status: ok ? "ok" : "error", checks: { database, queue, storage } });
      },
    );
  };
}
