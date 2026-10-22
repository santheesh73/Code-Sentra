import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type JsonValue, type ScanStage, ScanStage as ScanStageEnum } from "@codesentra/core";
import { fingerprint } from "@codesentra/core/hashing";
import {
  findReusableScan,
  getSnapshot,
  persistRunData,
  persistScanResult,
  resetScanRun,
  schema as s,
  setRunOutcome,
  updateSnapshot,
} from "@codesentra/db";
import type { JobHandler } from "@codesentra/queue";
import type { Sandbox } from "@codesentra/sandbox";
import type { FetchPolicy } from "@codesentra/ssrf";
import type { ObjectStore } from "@codesentra/storage";
import { eq } from "drizzle-orm";
import yazl from "yazl";
import type { OsvSource } from "./audit/osv.js";
import { cloneRepo, GitError, scratchDir } from "./ingest/git.js";
import { listTree, type TreeEntry, treeHash } from "./ingest/tree.js";
import { DEFAULT_ZIP_LIMITS, extractZip, ZipRejected } from "./ingest/zip.js";
import type { ReportModel } from "./model.js";
import { runScan } from "./pipeline.js";

export interface ScanJobDeps {
  store: ObjectStore | null;
  sandbox: () => Promise<{ sandbox: Sandbox; image: string } | { sandbox: null; reason: string }>;
  osv: { source: OsvSource } | { source: null; reason: string };
  secrets: { enabled: true } | { enabled: false; reason: string };
  model: { model: ReportModel } | { model: null; reason: string };
  gitPolicy: FetchPolicy;
  /** Plain http git for test hosts only (the harness has no TLS for git). */
  allowHttpGit: boolean;
  maxCommits: number;
}

/** Steps of a scan run (Section 8): one per stage. */
export const SCAN_STEPS: readonly ScanStage[] = ScanStageEnum.options;

async function archiveTree(root: string, files: TreeEntry[], out: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const f of files) zip.addFile(join(root, f.path), f.path);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(out));
}

/**
 * scan.run: ingest the run's snapshot (download + extract a zip, or clone git through the
 * SSRF pin), reuse an identical tree's scan when one exists, otherwise run Sentra Scan and
 * store evidence, findings, the code graph, features, the report and every claim.
 */
export function scanHandler(deps: ScanJobDeps): JobHandler {
  return async (ctx) => {
    const { run } = ctx.run;
    const orgId = ctx.payload.orgId;
    if (!run.snapshotId || !run.projectId) throw new Error("scan run has no snapshot");
    const snapshot = await ctx.db.withOrg(orgId, (tx) => getSnapshot(tx, run.snapshotId as string));
    if (!snapshot) throw new Error("snapshot disappeared");
    const scratch = await scratchDir();
    const skipRest = async (from: number, reason: string) => {
      for (const st of SCAN_STEPS.slice(from))
        await ctx.endStep(st, { status: "skipped", gapReason: reason });
    };
    try {
      // --- Ingest ------------------------------------------------------------------------
      await ctx.beginStep("ingest");
      const root = join(scratch.path, "tree");
      let files: TreeEntry[];
      try {
        if (!deps.store)
          throw new Error("object storage is not configured (S3_*); snapshots cannot be stored");
        if (snapshot.kind === "zip") {
          if (!snapshot.storageKey) throw new Error("zip snapshot has no stored archive");
          const zipPath = join(scratch.path, "upload.zip");
          await writeFile(zipPath, await deps.store.get(snapshot.storageKey));
          await extractZip(zipPath, root, DEFAULT_ZIP_LIMITS);
        } else {
          if (!snapshot.sourceUrl) throw new Error("git snapshot has no URL");
          const { commitSha } = await cloneRepo(snapshot.sourceUrl, root, {
            policy: deps.gitPolicy,
            maxCommits: deps.maxCommits,
            allowHttp: deps.allowHttpGit,
            ...(snapshot.ref ? { ref: snapshot.ref } : {}),
          });
          snapshot.commitSha = commitSha;
        }
        const listing = await listTree(root);
        files = listing.files;
        const hash = await treeHash(root, files);
        const bytes = files.reduce((n, f) => n + f.size, 0);
        if (bytes > DEFAULT_ZIP_LIMITS.maxBytes || files.length > DEFAULT_ZIP_LIMITS.maxFiles)
          throw new Error(`the tree is too large (${files.length} files, ${bytes} bytes)`);
        let storageKey = snapshot.storageKey;
        if (snapshot.kind === "git") {
          const archive = join(scratch.path, "tree.zip");
          await archiveTree(root, files, archive);
          storageKey = `snapshots/${orgId}/${snapshot.id}.zip`;
          await deps.store.put(storageKey, await readFile(archive), "application/zip");
        }
        await ctx.db.withOrg(orgId, (tx) =>
          updateSnapshot(tx, snapshot.id, {
            treeHash: hash,
            fileCount: files.length,
            sizeBytes: bytes,
            storageKey,
            commitSha: snapshot.commitSha,
            hasHistory: snapshot.kind === "git",
          }),
        );
        const reuse = await ctx.db.withOrg(orgId, (tx) =>
          findReusableScan(tx, {
            projectId: run.projectId as string,
            treeHash: hash,
            excludeRunId: run.id,
          }),
        );
        if (reuse) {
          await ctx.endStep("ingest", {
            status: "done",
            log: `${files.length} files; identical to the tree scanned in run ${reuse.runId}`,
          });
          await ctx.db.withOrg(orgId, async (tx) => {
            await tx.update(s.runs).set({ parentRunId: reuse.runId }).where(eq(s.runs.id, run.id));
            await setRunOutcome(tx, run.id, {
              cached: true,
              source_run_id: reuse.runId,
              tree_hash: hash,
            });
          });
          // Reused, not re-checked: the steps did not run here, and say so (Rule 2).
          await skipRest(
            1,
            `cached: the identical tree was scanned in run ${reuse.runId}; its report is reused`,
          );
          return;
        }
        await ctx.endStep("ingest", {
          status: "done",
          log: `${files.length} files, ${bytes} bytes, tree ${hash.slice(0, 12)}${snapshot.commitSha ? `, commit ${snapshot.commitSha.slice(0, 12)}` : ""}${listing.skippedSymlinks.length ? `; ${listing.skippedSymlinks.length} symlinks not followed` : ""}`,
        });
      } catch (e) {
        const msg =
          e instanceof ZipRejected
            ? `upload rejected (${e.code}): ${e.message}`
            : e instanceof GitError
              ? `clone failed (${e.code}): ${e.message}${e.stderr ? `\n${e.stderr.slice(-500)}` : ""}`
              : (e as Error).message;
        await ctx.endStep("ingest", { status: "failed", error: msg });
        await skipRest(1, "ingest failed");
        return;
      }

      // --- Stages ----------------------------------------------------------------------------
      const sandbox = await deps.sandbox();
      await mkdir(join(scratch.path, "probe"), { recursive: true });
      const result = await runScan({
        root,
        tree: files,
        hasHistory: snapshot.kind === "git",
        scratchDir: join(scratch.path, "probe"),
        sandbox,
        osv: deps.osv,
        secrets: deps.secrets,
        model: deps.model,
        maxCommits: deps.maxCommits,
        onStage: async (stage, state, detail) => {
          if (stage === "ingest") return;
          if (state === "running") await ctx.beginStep(stage);
          else if (state === "done")
            await ctx.endStep(stage, { status: "done", log: detail?.slice(0, 4000) });
          else if (state === "skipped")
            await ctx.endStep(stage, { status: "skipped", gapReason: detail ?? "not run" });
          else await ctx.endStep(stage, { status: "failed", error: detail ?? "failed" });
        },
      });

      // --- Persist --------------------------------------------------------------------------
      await ctx.db.withOrg(orgId, async (tx) => {
        await resetScanRun(tx, run.id, snapshot.id);
        const persisted = await persistRunData(tx, {
          orgId,
          runId: run.id,
          source: "scan",
          evidence: result.evidence,
          findings: result.findings.map((f) => ({
            ...f,
            fingerprint: fingerprint(f.code, "scan", f.locator, f.discriminator),
          })),
        });
        await persistScanResult(tx, {
          orgId,
          runId: run.id,
          snapshotId: snapshot.id,
          evidenceIds: persisted.evidenceIds,
          graph: {
            nodes: result.graph.nodes.map((n) => ({
              ...n,
              meta: n.meta as Record<string, JsonValue>,
            })),
            edges: result.graph.edges,
          },
          features: result.features.map((f) => ({
            name: f.name,
            status: f.status,
            reason: f.reason,
            evidenceKeys: f.evidenceIds,
          })),
          claims: result.claims.map((c) => ({
            section: c.section,
            text: c.text,
            evidenceKeys: c.evidence,
            verified: c.verified,
            dropReason: c.dropReason,
            dropDetail: c.dropDetail,
          })),
          report: {
            healthScore: result.health.score,
            // Deductions cite evidence keys; store the ids they became.
            healthBreakdown: {
              ...result.health,
              components: result.health.components.map((c) => ({
                ...c,
                deductions: c.deductions.map((d) => ({
                  ...d,
                  evidence: d.evidence
                    .map((k) => persisted.evidenceIds.get(k))
                    .filter((x): x is string => !!x),
                })),
              })),
            } as unknown as JsonValue,
            coverage: {
              gaps: result.gaps,
              checks: result.checks,
              stages: result.stages,
            } as unknown as JsonValue,
            summary: {
              languages: result.summary.languages,
              frameworks: result.summary.frameworks,
              package_manager: result.summary.packageManager,
              routes: result.summary.routes,
              env_vars: result.summary.envVars,
              probes: result.summary.probes
                ? result.summary.probes.results.map((p) => ({
                    name: p.name,
                    status: p.status,
                    reason: p.reason,
                    duration_ms: p.durationMs,
                    tests: p.tests,
                  }))
                : null,
              sandbox_runtime: result.summary.sandboxRuntime,
            } as unknown as JsonValue,
            model: result.summary.model,
            usage: result.usage as unknown as JsonValue,
          },
        });
        await setRunOutcome(tx, run.id, {
          cached: false,
          health_score: result.health.score,
          features: {
            complete: result.features.filter((f) => f.status === "complete").length,
            partial: result.features.filter((f) => f.status === "partial").length,
            planned: result.features.filter((f) => f.status === "planned").length,
          },
          claims: {
            total: result.claims.length,
            dropped: result.claims.filter((c) => !c.verified).length,
          },
          findings: result.findings.length,
          gaps: result.gaps,
          sandbox_runtime: result.summary.sandboxRuntime,
          model: result.summary.model,
          tokens: {
            input: result.usage.reduce((n, u) => n + u.inputTokens, 0),
            output: result.usage.reduce((n, u) => n + u.outputTokens, 0),
          },
        });
      });
    } finally {
      await scratch.cleanup();
    }
  };
}
