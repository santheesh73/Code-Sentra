import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../authz.js";
import type { AppContext } from "../context.js";
import { notImplemented, Problem } from "../errors.js";

type Scope = "project" | "run" | "issue" | "user" | "none";

interface Unbuilt {
  method: "GET" | "POST" | "DELETE";
  url: string;
  summary: string;
  phase: string;
  scope: Scope;
}

/**
 * Section 12 endpoints that later phases build. They authenticate and authorize like
 * the real thing (so cross-org tests cover them) and then answer 501 (Rule 6).
 */
export const UNBUILT: Unbuilt[] = [];

export function unbuiltRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    for (const r of UNBUILT) {
      const hasId = r.url.includes(":id");
      app.route({
        method: r.method,
        url: r.url,
        schema: {
          tags: ["not yet available"],
          summary: `${r.summary} (${r.phase})`,
          ...(hasId ? { params: z.object({ id: z.uuid() }) } : {}),
          response: { 401: Problem, 404: Problem, 501: Problem },
        },
        handler: async (req) => {
          const id = (req.params as { id?: string }).id ?? "";
          if (r.scope === "project") await ctx.authz.requireProject(req, id);
          else if (r.scope === "run") await ctx.authz.requireRun(req, id);
          else if (r.scope === "issue") await ctx.authz.requireIssue(req, id);
          else if (r.scope === "user") requireUser(req);
          throw notImplemented(r.summary, r.phase);
        },
      });
    }
  };
}
