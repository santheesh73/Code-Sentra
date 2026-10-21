import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";

const Check = z.enum(["ok", "error"]);
const Health = z.object({
  status: Check,
  checks: z.object({ database: Check, queue: Check }),
});

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
  };
}
