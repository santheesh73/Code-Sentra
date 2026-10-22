import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { draftIssues, type IssueDraftOut } from "@codesentra/checks";
import { createSandbox, dockerAvailable } from "@codesentra/sandbox";
import {
  anthropicModel,
  apiSource,
  cloneRepo,
  listTree,
  offlineSource,
  runScan,
  type ScanOptions,
  type ScanResult,
  scratchDir,
} from "@codesentra/scan";
import { defaultPolicy, type FetchPolicy, testPolicy } from "@codesentra/ssrf";

/** What a local scan runs with; tests inject these instead of reading the environment. */
export type ScanEnv = Pick<ScanOptions, "sandbox" | "osv" | "secrets" | "model"> & {
  gitPolicy: FetchPolicy;
  allowHttpGit: boolean;
};

const imageExists = (image: string) =>
  new Promise<boolean>((ok) => execFile("docker", ["image", "inspect", image], (err) => ok(!err)));

/**
 * Builds the scan environment from env vars, as worker-scan does: the sandbox when Docker
 * and the image are present, gitleaks when Docker is, the OSV API (or an offline dump),
 * and the report model when Anthropic is configured. Whatever is missing is a gap.
 */
export async function scanEnvFrom(env: Record<string, string | undefined>): Promise<ScanEnv> {
  const docker = await dockerAvailable();
  const image = env.SANDBOX_IMAGE ?? "codesentra/sandbox:latest";
  let sandbox: ScanEnv["sandbox"];
  if (docker) sandbox = { sandbox: null, reason: docker };
  else if (!(await imageExists(image)))
    sandbox = {
      sandbox: null,
      reason: `sandbox image ${image} not found (docker build -t ${image} infra/sandbox)`,
    };
  else
    sandbox = {
      sandbox: await createSandbox({
        network: env.SANDBOX_FETCH_NETWORK ?? "bridge",
        proxy: env.SANDBOX_FETCH_PROXY ?? null,
        caFile: env.SANDBOX_FETCH_CA_FILE ?? null,
      }),
      image,
    };
  const hosts = env.PULSE_TEST_ALLOW_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    sandbox,
    osv: { source: env.OSV_OFFLINE_DIR ? await offlineSource(env.OSV_OFFLINE_DIR) : apiSource() },
    secrets: docker ? { enabled: false, reason: docker } : { enabled: true },
    model:
      env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL
        ? { model: anthropicModel({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL }) }
        : {
            model: null,
            reason: "no report model (set ANTHROPIC_API_KEY and ANTHROPIC_MODEL)",
          },
    // Loopback git only in tests (ADR 0013); testPolicy() enforces NODE_ENV=test.
    gitPolicy: hosts?.length ? testPolicy(hosts, { env }) : defaultPolicy(),
    allowHttpGit: !!hosts?.length,
  };
}

export interface LocalScan {
  source: string;
  result: ScanResult;
  issues: IssueDraftOut[];
}

/** Scans a directory, or clones a git URL first (through the SSRF pin). */
export async function scanLocal(
  target: string,
  env: ScanEnv,
  onStage?: ScanOptions["onStage"],
): Promise<LocalScan> {
  const scratch = await scratchDir();
  try {
    let root: string;
    let hasHistory = false;
    if (/^(https?|git):\/\//.test(target)) {
      root = join(scratch.path, "tree");
      await cloneRepo(target, root, {
        policy: env.gitPolicy,
        maxCommits: 2000,
        allowHttp: env.allowHttpGit,
      });
      hasHistory = true;
    } else {
      root = resolve(target);
      const st = await stat(root).catch(() => null);
      if (!st?.isDirectory()) throw new ScanTargetError(`not a directory: ${target}`);
      hasHistory = !!(await stat(join(root, ".git")).catch(() => null));
    }
    const { files } = await listTree(root);
    const probeDir = join(scratch.path, "probe");
    await mkdir(probeDir, { recursive: true });
    const result = await runScan({
      root,
      tree: files,
      hasHistory,
      scratchDir: probeDir,
      sandbox: env.sandbox,
      osv: env.osv,
      secrets: env.secrets,
      model: env.model,
      onStage,
    });
    const issues = draftIssues(
      result.findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        evidenceKey: f.evidenceKey,
        locator: f.locator,
        discriminator: f.discriminator ?? null,
        message: f.message,
      })),
      result.evidence.map((e) => ({ ...e })),
      {
        target: { url: "", environment: null },
        project: null,
        platform: null,
        lastSuccessfulCheck: null,
        scanSummary: null,
      },
    );
    return { source: target, result, issues };
  } finally {
    await scratch.cleanup();
  }
}

export class ScanTargetError extends Error {}

/** Exit 0 only with no error findings and nothing skipped (Rule 2), as for Pulse. */
export function scanExitCode(s: LocalScan): number {
  return s.result.gaps.length || s.result.findings.some((f) => f.severity === "error") ? 1 : 0;
}

export function scanToJson(s: LocalScan): Record<string, unknown> {
  const r = s.result;
  const ev = new Map(r.evidence.map((e) => [e.key, e]));
  return {
    source: s.source,
    health: r.health,
    summary: r.summary,
    stages: r.stages,
    checks: r.checks,
    gaps: r.gaps,
    features: r.features.map((f) => ({
      name: f.name,
      status: f.status,
      reason: f.reason,
      evidence: f.evidenceIds.map((k) => ev.get(k)?.locator ?? k),
    })),
    report: r.claims
      .filter((c) => c.verified)
      .map((c) => ({
        section: c.section,
        text: c.text,
        evidence: c.evidence.map((k) => ev.get(k)?.locator ?? k),
      })),
    dropped_claims: r.claims
      .filter((c) => !c.verified)
      .map((c) => ({
        section: c.section,
        text: c.text,
        reason: c.dropReason,
        detail: c.dropDetail,
      })),
    findings: r.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      locator: f.locator,
      message: f.message,
    })),
    issues: s.issues.map((i) => ({
      title: i.title,
      code: i.code,
      severity: i.severity,
      recheck: i.recheck,
      prompt: {
        type: i.prompt.type,
        body: i.prompt.body,
        template_version: i.prompt.templateVersion,
      },
    })),
  };
}

export function scanToText(s: LocalScan, fixPrompt: boolean): string {
  const r = s.result;
  const lines = [`CodeSentra Scan · ${s.source}`];
  lines.push(
    `Health: ${r.health.score ?? "not measured"}${r.health.excluded.length ? ` (not measured: ${r.health.excluded.join(", ")})` : ""}`,
  );
  const langs = Object.entries(r.summary.languages).map(([l, n]) => `${l} ${n}`);
  if (langs.length) lines.push(`Languages: ${langs.join(", ")}`);
  if (r.summary.frameworks.length) lines.push(`Frameworks: ${r.summary.frameworks.join(", ")}`);
  if (r.gaps.length) {
    lines.push("", "Not checked:");
    for (const g of r.gaps) lines.push(`  ${g.stage}: ${g.reason}`);
  }
  const verified = r.claims.filter((c) => c.verified);
  if (verified.length) {
    lines.push("", "Report (every sentence verified against evidence):");
    for (const c of verified) lines.push(`  ${c.text}`);
  }
  const dropped = r.claims.length - verified.length;
  if (dropped) lines.push(`  (${dropped} unverifiable claim${dropped === 1 ? "" : "s"} dropped)`);
  if (r.features.length) {
    lines.push("", "Features:");
    for (const f of r.features) lines.push(`  ${f.status.padEnd(8)} ${f.name} — ${f.reason}`);
  }
  lines.push(
    "",
    s.issues.length ? `Issues (${s.issues.length}):` : "No issues found by the checks that ran.",
  );
  for (const i of s.issues) {
    lines.push(`  ${i.severity.toUpperCase().padEnd(7)} ${i.title}  [${i.code}]`);
    lines.push(`          ${i.summary}`);
  }
  const notes = r.findings.filter((f) => f.severity === "info");
  if (notes.length) {
    lines.push("", "Notes:");
    for (const f of notes) lines.push(`  ${f.message}`);
  }
  if (fixPrompt)
    for (const i of s.issues) {
      lines.push(
        "",
        `── Fix prompt: ${i.title} (${i.prompt.type}, ${i.prompt.templateVersion}) ──`,
      );
      lines.push(i.prompt.body.trimEnd());
    }
  else if (s.issues.length) lines.push("", "Run again with --fix-prompt for a prompt per issue.");
  return `${lines.join("\n")}\n`;
}
