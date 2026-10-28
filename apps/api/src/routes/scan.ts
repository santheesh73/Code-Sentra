import { ScanStage } from "@codesentra/core";
import { createSnapshot, getReport, schema as s, updateSnapshot } from "@codesentra/db";
import { createSourceSnapshot, installationFor } from "@codesentra/queue";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { LinkedRunAccepted, PublicHttpUrl, ReportDto, SnapshotDto, snapshotDto } from "../dto.js";
import { badRequest, notConfigured, notFound, Problem } from "../errors.js";
import { startLinked } from "../orchestrate.js";
import { assertPublicTarget } from "./pulse.js";

const GitSnapshot = z.object({
  kind: z.literal("git"),
  url: PublicHttpUrl.optional().describe("Defaults to the project's repo_url"),
  ref: z
    .string()
    .min(1)
    .max(250)
    .regex(/^[\w./-]+$/, "branch or tag name")
    .optional(),
});

const isZip = (b: Buffer) =>
  b.length >= 4 &&
  b[0] === 0x50 &&
  b[1] === 0x4b &&
  (b[2] === 0x03 || b[2] === 0x05) &&
  (b[3] === 0x04 || b[3] === 0x06);

/** Test only; packages/config refuses PULSE_TEST_ALLOW_HOSTS unless NODE_ENV=test. */
export function testAllowHosts(ctx: AppContext): ReadonlySet<string> {
  return new Set(
    (ctx.config.PULSE_TEST_ALLOW_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** A git snapshot of a public https repository (the clone itself is SSRF-pinned, ADR 0016). */
export async function createGitSnapshot(
  ctx: AppContext,
  testAllow: ReadonlySet<string>,
  input: { orgId: string; projectId: string; url: string; ref: string | null },
) {
  const u = new URL(input.url);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (u.protocol !== "https:" && !(u.protocol === "http:" && testAllow.has(host)))
    throw badRequest("Only https git URLs can be scanned");
  assertPublicTarget(input.url, testAllow);
  return ctx.db.withOrg(input.orgId, (tx) =>
    createSnapshot(tx, {
      orgId: input.orgId,
      projectId: input.projectId,
      kind: "git",
      sourceUrl: input.url,
      ref: input.ref,
    }),
  );
}

/**
 * The snapshot a full check or re-check scans (ADR 0024): the project's GitHub repository
 * at its default branch (with history) when an installation covers it, else a clone of
 * its public `repo_url`; null when it has neither.
 */
export async function projectSourceSnapshot(
  ctx: AppContext,
  testAllow: ReadonlySet<string>,
  project: typeof s.projects.$inferSelect,
): Promise<{ id: string } | null> {
  if (await installationFor(ctx.db, project, ctx.config.ENCRYPTION_KEY))
    return createSourceSnapshot(ctx.db, project, ctx.config.ENCRYPTION_KEY);
  if (!project.repoUrl) return null;
  return createGitSnapshot(ctx, testAllow, {
    orgId: project.orgId,
    projectId: project.id,
    url: project.repoUrl,
    ref: project.defaultBranch,
  });
}

export function scanRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const testAllow = testAllowHosts(ctx);
    const maxUpload = ctx.config.SCAN_MAX_UPLOAD_BYTES;

    // Zip uploads arrive as a raw application/zip body: no form can send that type, and a
    // cross-site fetch needs a CORS preflight, so the CSRF defence holds (ADR 0018).
    app.addContentTypeParser(
      "application/zip",
      { parseAs: "buffer", bodyLimit: maxUpload },
      (_req, body, done) => done(null, body),
    );

    const gitSnapshot = (orgId: string, projectId: string, url: string, ref: string | null) =>
      createGitSnapshot(ctx, testAllow, { orgId, projectId, url, ref });

    app.post(
      "/v1/projects/:id/snapshots",
      {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          tags: ["scan"],
          summary: "Upload a zip or register a git ref",
          description: `Send a zip as the raw request body with \`Content-Type: application/zip\` (at most ${maxUpload} bytes; extraction limits are applied at ingest), or JSON \`{ "kind": "git", "url"?, "ref"? }\` for a public https repository.`,
          params: z.object({ id: z.uuid() }),
          response: {
            201: SnapshotDto,
            400: Problem,
            401: Problem,
            404: Problem,
            413: Problem,
            501: Problem,
          },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        if (!ctx.store)
          throw notConfigured(
            "Snapshots",
            "S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
          );
        const [project] = await ctx.db.withOrg(access.orgId, (tx) =>
          tx.select().from(s.projects).where(eq(s.projects.id, req.params.id)),
        );
        if (!project) throw notFound("Project");
        const body: unknown = req.body;
        if (Buffer.isBuffer(body)) {
          if (!isZip(body)) throw badRequest("The body is not a zip archive");
          const snap = await ctx.db.withOrg(access.orgId, (tx) =>
            createSnapshot(tx, {
              orgId: access.orgId,
              projectId: project.id,
              kind: "zip",
              sizeBytes: body.length,
            }),
          );
          const key = `snapshots/${access.orgId}/${snap.id}.zip`;
          try {
            await ctx.store.put(key, body, "application/zip");
          } catch (e) {
            await ctx.db.withOrg(access.orgId, (tx) =>
              tx.delete(s.snapshots).where(eq(s.snapshots.id, snap.id)),
            );
            throw e;
          }
          await ctx.db.withOrg(access.orgId, (tx) =>
            updateSnapshot(tx, snap.id, { storageKey: key }),
          );
          return reply.code(201).send(snapshotDto({ ...snap, storageKey: key }));
        }
        const parsed = GitSnapshot.safeParse(body);
        if (!parsed.success)
          throw badRequest(
            'Send a zip (Content-Type: application/zip) or JSON { "kind": "git", "url"?, "ref"? }',
          );
        const url = parsed.data.url ?? project.repoUrl;
        if (!url) throw badRequest("The project has no repo_url; pass a url");
        const snap = await gitSnapshot(
          access.orgId,
          project.id,
          url,
          parsed.data.ref ?? project.defaultBranch ?? null,
        );
        return reply.code(201).send(snapshotDto(snap));
      },
    );

    app.post(
      "/v1/projects/:id/scan",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          tags: ["scan"],
          summary: "Start Sentra Scan",
          description:
            "Scans a snapshot (or, without snapshot_id, the project's repo_url at its default branch): map, history, sandboxed probes, dependency audit, secrets, feature inventory and an evidence-verified report.",
          params: z.object({ id: z.uuid() }),
          body: z.object({ snapshot_id: z.uuid().optional() }).optional(),
          response: {
            202: LinkedRunAccepted,
            400: Problem,
            401: Problem,
            404: Problem,
            501: Problem,
          },
        },
      },
      async (req, reply) => {
        const access = await ctx.authz.requireProject(req, req.params.id);
        if (!ctx.store)
          throw notConfigured(
            "Scan",
            "S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
          );
        const [project] = await ctx.db.withOrg(access.orgId, (tx) =>
          tx.select().from(s.projects).where(eq(s.projects.id, req.params.id)),
        );
        if (!project) throw notFound("Project");
        let snapshotId = req.body?.snapshot_id;
        if (snapshotId) {
          const [snap] = await ctx.db.withOrg(access.orgId, (tx) =>
            tx
              .select()
              .from(s.snapshots)
              .where(
                and(
                  eq(s.snapshots.id, snapshotId as string),
                  eq(s.snapshots.projectId, project.id),
                ),
              ),
          );
          if (!snap) throw notFound("Snapshot");
        } else {
          if (!project.repoUrl)
            throw badRequest("Upload a zip snapshot first, or set the project's repo_url");
          snapshotId = (
            await gitSnapshot(access.orgId, project.id, project.repoUrl, project.defaultBranch)
          ).id;
        }
        // The Scan feeds a Link run, which stores and re-checks its issues (ADR 0019).
        const started = await startLinked(ctx, {
          orgId: access.orgId,
          projectId: project.id,
          userId: access.user.id,
          trigger: req.tokenOrgId ? "cli" : "manual",
          children: [
            { job: "scan.run", run: { type: "scan", snapshotId, steps: ScanStage.options } },
          ],
        });
        return reply
          .code(202)
          .send({ run_id: started.childRunIds[0] as string, link_run_id: started.linkRunId });
      },
    );

    app.get(
      "/v1/runs/:id/report",
      {
        schema: {
          tags: ["scan"],
          summary:
            "Scan report: verified claims with evidence, features, health breakdown, coverage",
          params: z.object({ id: z.uuid() }),
          response: { 200: ReportDto, 401: Problem, 404: Problem },
        },
      },
      async (req) => {
        const access = await ctx.authz.requireRun(req, req.params.id);
        const view = await ctx.db.withOrg(access.orgId, (tx) => getReport(tx, req.params.id));
        if (!view)
          throw notFound(
            "Report",
            "The scan has not written a report (it is still running, or it failed before the report stage)",
          );
        const r = view.report;
        const health = r.healthBreakdown as {
          score: number | null;
          excluded: string[];
          components: {
            component: string;
            weight: number;
            measured: boolean;
            notMeasured: string[];
            ratio: number;
            deductions: { reason: string; points: number; evidence: string[] }[];
          }[];
        };
        const coverage = r.coverage as {
          gaps: { stage: string; reason: string }[];
          checks: Record<string, string>;
          stages: Record<string, string>;
        };
        const sections = r.sections as Record<string, { text: string; evidence_ids: string[] }[]>;
        return {
          run_id: req.params.id,
          source_run_id: view.sourceRunId,
          cached: view.sourceRunId !== req.params.id,
          health: {
            score: r.healthScore,
            excluded: health.excluded,
            components: health.components.map((c) => ({
              component: c.component,
              weight: c.weight,
              measured: c.measured,
              not_measured: c.notMeasured,
              ratio: c.ratio,
              deductions: c.deductions.map((d) => ({
                reason: d.reason,
                points: d.points,
                evidence_ids: d.evidence.filter((x) => /^[0-9a-f-]{36}$/.test(x)),
              })),
            })),
          },
          sections: {
            summary: sections.summary ?? [],
            value: sections.value ?? [],
            features: sections.features ?? [],
            issues: sections.issues ?? [],
            remaining: sections.remaining ?? [],
          },
          features: view.features.map((f) => ({
            name: f.name,
            status: f.status,
            reason: f.reason,
            evidence_ids: f.evidenceIds,
          })),
          claims_total: r.claimsTotal,
          claims_dropped: r.claimsDropped,
          dropped_claims: view.claims
            .filter((c) => !c.verified)
            .map((c) => ({
              section: c.section,
              text: c.text,
              reason: c.dropReason as string,
              detail: c.dropDetail,
              evidence_ids: c.evidenceIds,
            })),
          coverage: {
            gaps: coverage.gaps ?? [],
            checks: coverage.checks ?? {},
            stages: coverage.stages ?? {},
          },
          summary: r.summary as Record<string, unknown>,
          model: r.model,
          created_at: r.createdAt.toISOString(),
        };
      },
    );
  };
}
