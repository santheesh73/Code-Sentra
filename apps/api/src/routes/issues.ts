import { draftIssues, type PlatformIdentity } from "@codesentra/checks";
import type { IssueStatus, Severity } from "@codesentra/core";
import {
  dismissIssue,
  getEvidence,
  getFixPrompt,
  getIssueDetail,
  getRunWithSteps,
  listIssues,
  listRunFindings,
  schema as s,
} from "@codesentra/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  EvidenceDto,
  evidenceDto,
  findingDto,
  IssueDetailDto,
  IssueDto,
  issueDto,
  PromptDto,
  RunFindingsDto,
} from "../dto.js";
import { notConfigured, notFound, Problem } from "../errors.js";

const Id = z.object({ id: z.uuid() });
/** `?status=open,regressed` → validated array of enum values. */
function csvEnum<const T extends readonly [string, ...string[]]>(values: T) {
  const e = z.enum(values);
  return z
    .string()
    .optional()
    .transform((v, c) => {
      if (!v) return undefined;
      const out: z.infer<typeof e>[] = [];
      for (const raw of v.split(",")) {
        const r = e.safeParse(raw.trim());
        if (!r.success) {
          c.addIssue({
            code: "custom",
            message: `"${raw.trim()}" is not one of ${values.join(", ")}`,
          });
          return z.NEVER;
        }
        out.push(r.data);
      }
      return out;
    });
}

export function issueRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/v1/projects/:id/issues",
      {
        schema: {
          tags: ["issues"],
          summary: "Issues for a project, most severe first",
          params: Id,
          querystring: z.object({
            status: csvEnum([
              "open",
              "resolved",
              "regressed",
              "dismissed",
            ] as const satisfies readonly IssueStatus[]),
            severity: csvEnum(["error", "warning", "info"] as const satisfies readonly Severity[]),
            source: csvEnum(["scan", "pulse"] as const),
          }),
          response: { 200: z.array(IssueDto), 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        const rows = await ctx.db.withOrg(access.orgId, (tx) =>
          listIssues(tx, req.params.id, {
            status: req.query.status,
            severity: req.query.severity,
            source: req.query.source,
          }),
        );
        return rows.map(issueDto);
      },
    );

    app.get(
      "/v1/issues/:id",
      {
        schema: {
          tags: ["issues"],
          summary: "Issue with history, evidence and its fix prompt",
          params: Id,
          response: { 200: IssueDetailDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireIssue(req, req.params.id);
        const d = await ctx.db.withOrg(access.orgId, (tx) => getIssueDetail(tx, req.params.id));
        if (!d) throw notFound("Issue");
        if (!d.prompt) throw new Error(`issue ${d.issue.id} has no prompt (Rule 4 violated)`);
        return {
          ...issueDto(d.issue),
          prompt: {
            type: d.prompt.type,
            body: d.prompt.body,
            template_version: d.prompt.templateVersion,
            version: d.prompt.version,
          },
          events: d.events.map((e) => ({
            kind: e.kind,
            run_id: e.runId,
            note: e.note,
            at: e.createdAt.toISOString(),
          })),
          observed: d.observed.map((o) => findingDto(o.finding, o.evidence)),
          traces: d.traces.map((tr) => ({
            path: tr.path,
            line: tr.line,
            symbol: tr.symbol,
            excerpt: tr.excerpt,
            join_key: tr.joinKey,
            env_vars: tr.envVars as { name: string; documented: boolean }[],
            run_id: tr.runId,
          })),
          blast_radius: d.prompt.blastRadius as { path: string; reason: string }[],
        };
      },
    );

    app.get(
      "/v1/issues/:id/fix-prompt",
      {
        schema: {
          tags: ["issues"],
          summary: "The issue's fix prompt (latest, or ?version=)",
          params: Id,
          querystring: z.object({ version: z.coerce.number().int().min(1).optional() }),
          response: { 200: PromptDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireIssue(req, req.params.id);
        const p = await ctx.db.withOrg(access.orgId, (tx) =>
          getFixPrompt(tx, req.params.id, req.query.version),
        );
        if (!p) throw notFound("Prompt version");
        return {
          type: p.type,
          body: p.body,
          template_version: p.templateVersion,
          version: p.version,
        };
      },
    );

    app.post(
      "/v1/issues/:id/dismiss",
      {
        schema: {
          tags: ["issues"],
          summary: "Dismiss an issue with a reason (audited)",
          params: Id,
          body: z.object({ reason: z.string().trim().min(3).max(500) }),
          response: { 200: IssueDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireIssue(req, req.params.id);
        const row = await ctx.db.withOrg(access.orgId, async (tx) => {
          const r = await dismissIssue(tx, {
            orgId: access.orgId,
            issueId: req.params.id,
            actorId: access.user.id,
            reason: req.body.reason,
          });
          if (r) {
            await tx.insert(s.auditLog).values({
              orgId: access.orgId,
              actorId: access.user.id,
              action: "issue.dismissed",
              target: `issue:${r.id}`,
              metadata: { reason: req.body.reason, code: r.code },
            });
          }
          return r;
        });
        if (!row) throw notFound("Issue");
        return issueDto(row);
      },
    );

    app.get(
      "/v1/evidence/:id",
      {
        schema: {
          tags: ["evidence"],
          summary: "One evidence record",
          params: Id,
          response: { 200: EvidenceDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireEvidence(req, req.params.id);
        const e = await ctx.db.withOrg(access.orgId, (tx) => getEvidence(tx, req.params.id));
        if (!e) throw notFound("Evidence");
        return evidenceDto(e);
      },
    );

    app.get(
      "/v1/runs/:id/findings",
      {
        schema: {
          tags: ["runs"],
          summary: "Findings for a run, grouped into issues with fix prompts",
          params: Id,
          response: { 200: RunFindingsDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireRun(req, req.params.id);
        return ctx.db.withOrg(access.orgId, async (tx) => {
          const run = await getRunWithSteps(tx, req.params.id);
          if (!run) throw notFound("Run");
          const rows = await listRunFindings(tx, req.params.id);
          const outcome = (run.run.outcome ?? null) as Record<string, unknown> | null;
          const platform = (outcome?.platform ?? null) as PlatformIdentity | null;
          const [env] = run.run.environmentId
            ? await tx
                .select()
                .from(s.environments)
                .where(eq(s.environments.id, run.run.environmentId))
            : [];
          const evidence = [...new Map(rows.map((r) => [r.evidence.id, r.evidence])).values()];
          const drafts = draftIssues(
            rows.map((r) => ({
              code: r.finding.code,
              severity: r.finding.severity,
              evidenceKey: r.finding.evidenceId,
              locator: r.finding.locator,
              discriminator: r.finding.discriminator,
              message: r.finding.message,
            })),
            evidence.map((e) => ({
              key: e.id,
              kind: e.kind,
              locator: e.locator,
              payload: e.payload as never,
            })),
            {
              target: { url: run.run.targetUrl ?? "", environment: env?.name ?? null },
              project: null,
              platform,
              lastSuccessfulCheck: null,
              scanSummary: null,
            },
          );
          const stored =
            run.run.projectId && drafts.length > 0
              ? await tx
                  .select({ id: s.issues.id, fingerprint: s.issues.fingerprint })
                  .from(s.issues)
                  .where(
                    and(
                      eq(s.issues.projectId, run.run.projectId),
                      inArray(
                        s.issues.fingerprint,
                        drafts.map((d) => d.fingerprint),
                      ),
                    ),
                  )
              : [];
          const idByFp = new Map(stored.map((i) => [i.fingerprint, i.id]));
          return {
            run_id: run.run.id,
            outcome,
            findings: rows.map((r) => findingDto(r.finding, r.evidence)),
            issues: drafts.map((d) => ({
              issue_id: idByFp.get(d.fingerprint) ?? null,
              title: d.title,
              code: d.code,
              severity: d.severity,
              corroborating_codes: d.corroboratingCodes,
              finding_ids: d.findingIndexes
                .map((i) => rows[i]?.finding.id)
                .filter((x): x is string => Boolean(x)),
              prompt: {
                type: d.prompt.type,
                body: d.prompt.body,
                template_version: d.prompt.templateVersion,
                version: null,
              },
              recheck: d.recheck,
            })),
          };
        });
      },
    );

    app.get(
      "/v1/runs/:id/screenshot",
      {
        schema: {
          tags: ["runs"],
          summary: "PNG screenshot captured by a Pulse render check",
          params: Id,
          response: {
            200: z.any().describe("image/png"),
            401: Problem,
            404: Problem,
            501: Problem,
          },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireRun(req, req.params.id);
        if (!ctx.store)
          throw notConfigured(
            "Screenshots",
            "S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
          );
        const [shot] = await ctx.db.withOrg(access.orgId, (tx) =>
          tx
            .select()
            .from(s.evidence)
            .where(and(eq(s.evidence.runId, req.params.id), eq(s.evidence.kind, "screenshot"))),
        );
        const key = (shot?.payload as { storage_key?: string } | undefined)?.storage_key;
        if (!key) throw notFound("Screenshot");
        const bytes = await ctx.store.get(key);
        return reply
          .type("image/png")
          .header("cache-control", "private, max-age=3600")
          .send(Buffer.from(bytes));
      },
    );
  };
}
