import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckName,
  type CheckOutcome,
  type VerifierEvidence,
  verifyClaim,
} from "@codesentra/claims";
import {
  computeHealth,
  type FeatureStatus,
  type HealthScore,
  type JsonValue,
  REPORT_SECTIONS,
  type ReportSection,
  type ScanStage,
} from "@codesentra/core";
import { analyzeHistory, parseGitLog } from "@codesentra/graph";
import type { Sandbox } from "@codesentra/sandbox";
import { isLockfile, type LockedPackage, parseLockfile } from "./audit/lockfiles.js";
import { auditPackages, type OsvSource } from "./audit/osv.js";
import { recordAudit, recordHistory, recordProbes, recordSecrets } from "./collect.js";
import { gitLog } from "./ingest/git.js";
import type { TreeEntry } from "./ingest/tree.js";
import { type ClassifiedFeature, classifyFeatures } from "./inventory.js";
import { mapProject } from "./map.js";
import { type BundleItem, ModelError, type ReportModel, type Usage } from "./model.js";
import { planProbes } from "./probe/plan.js";
import { type ProbeRun, runProbes } from "./probe/run.js";
import { type EvidenceDraft, type FindingDraft, ScanRecorder } from "./recorder.js";
import { scanSecrets } from "./secrets.js";

export const SCAN_STAGES: readonly ScanStage[] = [
  "ingest",
  "map",
  "history",
  "probe",
  "inventory",
  "explain",
];

export interface ScanOptions {
  /** The snapshot tree (with `.git` for git snapshots). Never executed in place. */
  root: string;
  tree: TreeEntry[];
  hasHistory: boolean;
  scratchDir: string;
  sandbox: { sandbox: Sandbox; image: string } | { sandbox: null; reason: string };
  osv: { source: OsvSource } | { source: null; reason: string };
  /** gitleaks needs Docker; null skips it with the reason. */
  secrets: { enabled: true } | { enabled: false; reason: string };
  model: { model: ReportModel } | { model: null; reason: string };
  maxCommits?: number;
  onStage?: (
    stage: ScanStage,
    state: "running" | "done" | "skipped" | "failed",
    detail?: string,
  ) => void | Promise<void>;
}

export interface ScanClaim {
  section: ReportSection;
  text: string;
  /** Evidence keys (draft keys, mapped to ids when persisted). */
  evidence: string[];
  verified: boolean;
  dropReason: string | null;
  dropDetail: string | null;
}

export interface ScanResult {
  evidence: EvidenceDraft[];
  findings: FindingDraft[];
  features: ClassifiedFeature[];
  droppedFeatures: { name: string; reason: string }[];
  claims: ScanClaim[];
  health: HealthScore;
  checks: Record<string, CheckOutcome>;
  /** Stages that did not run (or ran only in part), with the reason (Rule 2). */
  gaps: { stage: ScanStage; reason: string }[];
  stages: Record<ScanStage, "done" | "skipped" | "failed">;
  usage: Usage[];
  summary: {
    languages: Record<string, number>;
    frameworks: string[];
    packageManager: string | null;
    routes: { method: string; path: string; locator: string }[];
    envVars: { read: string[]; documented: string[] };
    probes: ProbeRun | null;
    sandboxRuntime: string | null;
    model: string | null;
  };
}

const BUNDLE_LIMIT = 150_000;
const KIND_PRIORITY = [
  "manifest",
  "doc_excerpt",
  "route",
  "code_fact",
  "test_result",
  "probe_result",
  "env_var_read",
  "env_var_documented",
  "dependency_advisory",
  "secret_match",
  "marker",
  "hotspot",
  "commit_stats",
  "language_coverage",
];

/** Compact, prioritized evidence for the model (README, manifests, routes, findings first). */
export function buildBundle(rec: ScanRecorder): BundleItem[] {
  const findingsBy = new Map<string, string[]>();
  for (const f of rec.findings)
    findingsBy.set(f.evidenceKey, [
      ...(findingsBy.get(f.evidenceKey) ?? []),
      `${f.code}: ${f.message}`,
    ]);
  const items = [...rec.evidence].sort(
    (a, b) =>
      KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
  const out: BundleItem[] = [];
  let size = 0;
  for (const e of items) {
    const { excerpt: _x, ...payload } = e.payload as Record<string, unknown>;
    const findings = findingsBy.get(e.key);
    const summary = `${JSON.stringify(payload).slice(0, 600)}${findings ? ` | findings: ${findings.join("; ").slice(0, 400)}` : ""}`;
    size += summary.length + e.locator.length + 40;
    if (size > BUNDLE_LIMIT) break;
    out.push({ id: e.key, kind: e.kind, locator: e.locator, summary });
  }
  return out;
}

function readTree(root: string, tree: TreeEntry[]) {
  const files = new Set(tree.map((t) => t.path));
  return {
    files,
    read: (p: string) => (files.has(p) ? readFileSync(join(root, p), "utf8") : null),
  };
}

/** Runs Sentra Scan over an ingested snapshot (Section 8). Collectors write evidence; the model writes only verified claims. */
export async function runScan(o: ScanOptions): Promise<ScanResult> {
  const rec = new ScanRecorder();
  const gaps: ScanResult["gaps"] = [];
  const stages = { ingest: "done" } as ScanResult["stages"];
  const usage: Usage[] = [];
  const stage = async (
    s: ScanStage,
    state: "running" | "done" | "skipped" | "failed",
    detail?: string,
  ) => {
    if (state !== "running") stages[s] = state;
    if (state === "skipped" || state === "failed")
      gaps.push({ stage: s, reason: detail ?? "did not run" });
    await o.onStage?.(s, state, detail);
  };

  // --- Map --------------------------------------------------------------------------------
  await stage("map", "running");
  const map = await mapProject(o.root, o.tree, rec);
  for (const g of map.gaps) gaps.push({ stage: "map", reason: g });
  await stage(
    "map",
    "done",
    `${map.facts.length} files parsed; ${Object.entries(map.languages)
      .map(([l, n]) => `${l} ${n}`)
      .join(", ")}`,
  );

  // --- History ----------------------------------------------------------------------------
  let hotspotEvidence: string[] | null = null;
  if (!o.hasHistory) {
    await stage("history", "skipped", "no git history (zip snapshot)");
  } else {
    await stage("history", "running");
    try {
      const commits = parseGitLog(await gitLog(o.root, o.maxCommits ?? 2000));
      const h = analyzeHistory(commits, new Set(map.paths));
      const spots = recordHistory(rec, map, h);
      hotspotEvidence = spots.map(
        (s) =>
          rec.evidence.find((e) => e.kind === "hotspot" && e.locator === s.path)?.key as string,
      );
      await stage(
        "history",
        "done",
        `${h.commits} commits, ${h.contributors} contributors, ${spots.length} hotspots`,
      );
    } catch (e) {
      await stage("history", "failed", `git log failed: ${(e as Error).message}`);
    }
  }

  // --- Probe (sandbox), dependency audit and secrets (outside the sandbox) ------------------
  await stage("probe", "running");
  const checks: Record<string, CheckOutcome> = {};
  let probes: ProbeRun | null = null;
  const probeGaps: string[] = [];
  if (o.sandbox.sandbox) {
    try {
      probes = await runProbes({
        sandbox: o.sandbox.sandbox,
        image: o.sandbox.image,
        sourceDir: o.root,
        scratchDir: o.scratchDir,
        plan: planProbes(readTree(o.root, o.tree)),
      });
      Object.assign(checks, recordProbes(rec, map, probes));
      for (const r of probes.results)
        if (r.status === "skipped") probeGaps.push(`${r.name}: ${r.reason}`);
    } catch (e) {
      probeGaps.push(`sandbox probes failed: ${(e as Error).message}`);
    }
  } else {
    probeGaps.push(`install, build, typecheck, lint and tests not run: ${o.sandbox.reason}`);
  }
  for (const n of ["install", "build", "typecheck", "lint", "tests"]) checks[n] ??= "skipped";

  const lockfiles = map.paths.filter(isLockfile);
  const pkgs: LockedPackage[] = [];
  for (const f of lockfiles) {
    const p = parseLockfile(f, map.text.get(f) ?? readFileSync(join(o.root, f), "utf8"));
    if (!p) probeGaps.push(`dependency audit: ${f} could not be read`);
    else {
      pkgs.push(...p.packages);
      if (p.ecosystem === "PyPI" && p.file.endsWith(".txt"))
        probeGaps.push(
          `dependency audit: ${f} pins direct dependencies only; transitive dependencies were not audited`,
        );
    }
  }
  if (!lockfiles.length) {
    checks.dependency_audit = "skipped";
    probeGaps.push("dependency audit: no lockfile");
  } else if (!o.osv.source) {
    checks.dependency_audit = "skipped";
    probeGaps.push(`dependency audit not run: ${o.osv.reason}`);
  } else {
    try {
      const r = recordAudit(rec, await auditPackages(o.osv.source, pkgs), o.osv.source.description);
      checks.dependency_audit = r.outcome;
      probeGaps.push(...r.gaps.map((g) => `dependency audit: ${g}`));
    } catch (e) {
      checks.dependency_audit = "skipped";
      probeGaps.push(`dependency audit failed: ${(e as Error).message}`);
    }
  }
  let secretsRan = false;
  if (o.secrets.enabled) {
    try {
      // Scan the pristine tree; the probe scratch copy is never scanned.
      checks.secrets = recordSecrets(rec, await scanSecrets(o.root));
      secretsRan = true;
    } catch (e) {
      checks.secrets = "skipped";
      probeGaps.push(`secrets scan failed: ${(e as Error).message}`);
    }
  } else {
    checks.secrets = "skipped";
    probeGaps.push(`secrets scan not run: ${o.secrets.reason}`);
  }
  for (const g of probeGaps) gaps.push({ stage: "probe", reason: g });
  await stage(
    "probe",
    probes || secretsRan ? "done" : "skipped",
    probeGaps.join("\n") || "all probes ran",
  );

  // --- Health (deterministic; never the model) ----------------------------------------------
  const keysOf = (pred: (e: EvidenceDraft) => boolean) =>
    rec.evidence.filter(pred).map((e) => e.key);
  const probeKey = (name: string) =>
    keysOf((e) => e.kind === "probe_result" && e.payload.probe === name);
  const outcome = (name: string) =>
    (probes?.results.find((r) => r.name === name)?.status ?? "skipped") as
      | "pass"
      | "fail"
      | "timeout"
      | "not_applicable"
      | "skipped";
  const tests = probes?.results.find((r) => r.name === "tests")?.tests;
  const testCount = map.facts.reduce((n, f) => n + f.tests.length, 0);
  const health = computeHealth({
    install: { outcome: outcome("install"), evidence: probeKey("install") },
    build: { outcome: outcome("build"), evidence: probeKey("build") },
    tests: {
      outcome: testCount === 0 ? "fail" : checks.tests === "skipped" ? "skipped" : outcome("tests"),
      pass: tests?.pass ?? 0,
      fail: tests?.fail ?? 0,
      testsFound: testCount,
      evidence: [
        ...probeKey("tests"),
        ...keysOf((e) => e.kind === "code_fact" && e.payload.kind === "tests"),
      ],
    },
    typecheck: { outcome: outcome("typecheck"), evidence: probeKey("typecheck") },
    lint: { outcome: outcome("lint"), evidence: probeKey("lint") },
    vulnerable:
      checks.dependency_audit === "skipped" &&
      !rec.findings.some((f) => f.code === "VULNERABLE_DEPENDENCY")
        ? null
        : rec.findings
            .filter((f) => f.code === "VULNERABLE_DEPENDENCY")
            .map((f) => {
              const ev = rec.byKey(f.evidenceKey);
              const sev = ((ev?.payload.advisories as { severity: string }[] | undefined)?.[0]
                ?.severity ?? "unknown") as "critical" | "high" | "moderate" | "low" | "unknown";
              return { severity: sev, evidence: f.evidenceKey };
            }),
    secrets: secretsRan
      ? rec.findings
          .filter((f) => f.code === "SECRET_EXPOSED")
          .map((f) => ({ evidence: f.evidenceKey }))
      : null,
    readme: {
      present: map.hasReadme,
      evidence: keysOf(
        (e) => e.kind === "doc_excerpt" && /^readme/i.test(String(e.payload.file)),
      ).slice(0, 1),
    },
    envVars: {
      read: map.envRead.size,
      undocumented: rec.findings
        .filter((f) => f.code === "ENV_VAR_UNDOCUMENTED")
        .map((f) => ({ evidence: f.evidenceKey })),
    },
    setupSteps: {
      present: map.hasSetupSteps,
      evidence: keysOf(
        (e) =>
          e.kind === "doc_excerpt" &&
          /setup|install|getting started|quick ?start/i.test(String(e.payload.section)),
      ).slice(0, 3),
    },
    markers: {
      count: map.markers,
      sourceLines: map.sourceLines,
      evidence: keysOf(
        (e) => e.kind === "marker" || (e.kind === "code_fact" && e.payload.kind === "stub"),
      ),
    },
    hotspots: hotspotEvidence
      ? { count: hotspotEvidence.length, files: map.paths.length, evidence: hotspotEvidence }
      : null,
  });

  // --- Inventory and Explain (model proposes, deterministic code decides) -------------------
  const verifierEvidence = new Map<string, VerifierEvidence>(
    rec.evidence.map((e) => [
      e.key,
      {
        id: e.key,
        runId: "this-run",
        kind: e.kind,
        locator: e.locator,
        payload: e.payload as JsonValue,
      },
    ]),
  );
  let features: ClassifiedFeature[] = [];
  let droppedFeatures: ScanResult["droppedFeatures"] = [];
  const claims: ScanClaim[] = [];
  const markedFiles = new Map<string, string[]>();
  for (const e of rec.evidence)
    if (e.kind === "marker" || (e.kind === "code_fact" && e.payload.kind === "stub")) {
      const f = String(e.payload.file);
      markedFiles.set(f, [...(markedFiles.get(f) ?? []), e.key]);
    }
  const reachCache = new Map<string, Set<string>>();
  const reaches = (file: string) => {
    let r = reachCache.get(file);
    if (r) return r;
    r = new Set<string>();
    const stack = [file];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const e of map.graph.edges)
        if (e.kind === "imports" && e.from === `file:${cur}`) {
          const to = e.to.slice(5);
          if (!r.has(to)) {
            r.add(to);
            stack.push(to);
          }
        }
    }
    reachCache.set(file, r);
    return r;
  };

  if (!o.model.model) {
    await stage(
      "inventory",
      "skipped",
      `feature inventory needs the report model: ${o.model.reason}`,
    );
    await stage("explain", "skipped", `report prose needs the report model: ${o.model.reason}`);
  } else {
    const model = o.model.model;
    const bundle = buildBundle(rec);
    await stage("inventory", "running");
    try {
      const { proposal, usage: u } = await model.proposeFeatures(bundle);
      usage.push(...u);
      const c = classifyFeatures(proposal, {
        evidence: new Map(
          rec.evidence.map((e) => [
            e.key,
            { id: e.key, kind: e.kind, locator: e.locator, payload: e.payload },
          ]),
        ),
        markedFiles,
        reaches,
      });
      features = c.features;
      droppedFeatures = c.dropped;
      // A feature the docs list as existing, with no implementation, is DOCUMENTED_FEATURE_MISSING.
      for (const f of features.filter((x) => x.status === "planned")) {
        const intent = f.intentIds
          .map((k) => rec.byKey(k))
          .find(
            (e) =>
              e?.kind === "doc_excerpt" &&
              !/roadmap|planned|future|todo|later/i.test(String(e.payload.section)),
          );
        if (intent)
          rec.addFinding(
            "DOCUMENTED_FEATURE_MISSING",
            intent.key,
            intent.locator,
            `"${f.name}" is documented (${intent.locator}) but no implementation was found.`,
            f.name,
          );
      }
      await stage(
        "inventory",
        "done",
        `${features.length} features (${droppedFeatures.length} proposals dropped)`,
      );
    } catch (e) {
      if (e instanceof ModelError) usage.push(...e.usage);
      await stage("inventory", "failed", `feature inventory failed: ${(e as Error).message}`);
    }

    await stage("explain", "running");
    try {
      const { draft, usage: u } = await model.draftReport({
        bundle: buildBundle(rec),
        features: features.map((f) => ({
          name: f.name,
          status: f.status,
          reason: f.reason,
          evidence_ids: f.evidenceIds,
        })),
        checks: checks as Record<string, string>,
        health: { score: health.score, excluded: health.excluded },
      });
      usage.push(...u);
      const ctx = {
        runIds: new Set(["this-run"]),
        evidence: verifierEvidence,
        features: features.map((f) => ({
          name: f.name,
          status: f.status as FeatureStatus,
          evidenceIds: f.evidenceIds,
        })),
        checks: checks as Partial<Record<CheckName, CheckOutcome>>,
      };
      for (const section of REPORT_SECTIONS)
        for (const c of draft[section]) {
          const v = verifyClaim({ text: c.text, evidence_ids: c.evidence_ids }, ctx);
          claims.push({
            section,
            text: c.text,
            evidence: c.evidence_ids,
            verified: v.verified,
            dropReason: v.verified ? null : v.reason,
            dropDetail: v.verified ? null : v.detail,
          });
        }
      await stage(
        "explain",
        "done",
        `${claims.filter((c) => c.verified).length} claims verified, ${claims.filter((c) => !c.verified).length} dropped`,
      );
    } catch (e) {
      if (e instanceof ModelError) usage.push(...e.usage);
      await stage("explain", "failed", `report writing failed: ${(e as Error).message}`);
    }
  }

  return {
    evidence: rec.evidence,
    findings: rec.findings,
    features,
    droppedFeatures,
    claims,
    health,
    checks,
    gaps,
    stages,
    usage,
    summary: {
      languages: map.languages,
      frameworks: map.frameworks,
      packageManager: map.packageManager,
      routes: map.facts.flatMap((f) =>
        f.routes.map((r) => ({ method: r.method, path: r.path, locator: `${f.path}:${r.line}` })),
      ),
      envVars: {
        read: [...map.envRead.keys()].sort(),
        documented: [...map.envDocumented.keys()].sort(),
      },
      probes,
      sandboxRuntime: probes?.runtime ?? null,
      model: o.model.model?.name ?? null,
    },
  };
}
