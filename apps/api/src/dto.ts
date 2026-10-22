import {
  FindingCode,
  IssueEventKind,
  IssueStatus,
  MembershipRole,
  PromptType,
  PulseStatus,
  RunStatus,
  RunStepStatus,
  RunTrigger,
  RunType,
  Severity,
} from "@codesentra/core";
import type { RunWithSteps, schema } from "@codesentra/db";
import { z } from "zod";

const ts = z.iso.datetime();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const UserDto = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string().nullable(),
    avatar_url: z.string().nullable(),
  })
  .meta({ id: "User" });
export const OrgDto = z
  .object({ id: z.uuid(), name: z.string(), slug: z.string(), role: MembershipRole })
  .meta({ id: "Organization" });
export const MeDto = z.object({ user: UserDto, organizations: z.array(OrgDto) }).meta({ id: "Me" });
export const MemberDto = z
  .object({ user: UserDto, role: MembershipRole, joined_at: ts })
  .meta({ id: "Member" });

/** Latest Pulse result for an environment; null until one has finished (never assumed live). */
export const EnvironmentStatusDto = z
  .object({
    pulse_status: PulseStatus,
    run_id: z.uuid(),
    checked_at: ts,
    gaps: z.array(z.object({ group: z.string(), reason: z.string() })),
  })
  .meta({ id: "EnvironmentStatus" });

export const EnvironmentDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    url: z.url(),
    created_at: ts,
    status: EnvironmentStatusDto.nullable(),
  })
  .meta({ id: "Environment" });

export const RunStepDto = z
  .object({
    name: z.string(),
    position: z.number().int(),
    status: RunStepStatus,
    started_at: ts.nullable(),
    finished_at: ts.nullable(),
    duration_ms: z.number().int().nullable(),
    gap_reason: z.string().nullable(),
    error: z.string().nullable(),
    log: z.string().nullable(),
  })
  .meta({ id: "RunStep" });

export const RunSummaryDto = z
  .object({
    id: z.uuid(),
    org_id: z.uuid(),
    project_id: z.uuid().nullable(),
    environment_id: z.uuid().nullable(),
    type: RunType,
    trigger: RunTrigger,
    status: RunStatus,
    target_url: z.string().nullable(),
    /** The Link run this run feeds (Scan and Pulse runs of a project; ADR 0019). */
    parent_run_id: z.uuid().nullable(),
    error: z.string().nullable(),
    created_at: ts,
    started_at: ts.nullable(),
    finished_at: ts.nullable(),
    /** Module-specific result, e.g. { pulse_status, gaps, platform, final_url } for Pulse runs. */
    outcome: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: "RunSummary" });

export const RunDto = RunSummaryDto.extend({
  steps: z.array(RunStepDto),
  /** Every step that did not run, with its reason (Rule 2). */
  gaps: z.array(z.object({ step: z.string(), reason: z.string() })),
  /** For a Link run: the Scan and Pulse runs it waits for and combines. */
  children: z.array(RunSummaryDto),
}).meta({ id: "Run" });

export const ProjectDto = z
  .object({
    id: z.uuid(),
    org_id: z.uuid(),
    name: z.string(),
    repo_url: z.string().nullable(),
    default_branch: z.string().nullable(),
    platform: z.string().nullable(),
    github_repo: z.string().nullable(),
    check_on_push: z.boolean(),
    environments: z.array(EnvironmentDto),
    latest_run: RunSummaryDto.nullable(),
    latest_scan: z
      .object({
        run_id: z.uuid(),
        status: RunStatus,
        health_score: z.number().int().nullable(),
        finished_at: ts,
      })
      .nullable()
      .describe("The latest finished Scan; null until one has run"),
    open_issues: z.number().int(),
    created_at: ts,
    updated_at: ts,
  })
  .meta({ id: "Project" });

export const RunAccepted = z.object({ run_id: z.uuid() }).meta({ id: "RunAccepted" });
export const LinkedRunAccepted = z
  .object({
    run_id: z.uuid(),
    link_run_id: z.uuid().describe("The Link run that follows it and updates the project's issues"),
  })
  .meta({ id: "LinkedRunAccepted" });

type UserRow = typeof schema.users.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;
type EnvRow = typeof schema.environments.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

export const userDto = (
  u: Pick<UserRow, "id" | "email" | "name" | "avatarUrl">,
): z.infer<typeof UserDto> => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatar_url: u.avatarUrl,
});

export const environmentDto = (
  e: EnvRow,
  latestPulse: RunRow | null = null,
): z.infer<typeof EnvironmentDto> => {
  const o = (latestPulse?.outcome ?? null) as {
    pulse_status?: string;
    gaps?: { group: string; reason: string }[];
  } | null;
  const parsed = PulseStatus.safeParse(o?.pulse_status);
  return {
    id: e.id,
    name: e.name,
    url: e.url,
    created_at: e.createdAt.toISOString(),
    status:
      latestPulse && parsed.success
        ? {
            pulse_status: parsed.data,
            run_id: latestPulse.id,
            checked_at: (latestPulse.finishedAt ?? latestPulse.createdAt).toISOString(),
            gaps: o?.gaps ?? [],
          }
        : null,
  };
};

export const runSummaryDto = (r: RunRow): z.infer<typeof RunSummaryDto> => ({
  id: r.id,
  org_id: r.orgId,
  project_id: r.projectId,
  environment_id: r.environmentId,
  type: r.type,
  trigger: r.trigger,
  status: r.status,
  target_url: r.targetUrl,
  parent_run_id: r.parentRunId,
  error: r.error,
  created_at: r.createdAt.toISOString(),
  started_at: iso(r.startedAt),
  finished_at: iso(r.finishedAt),
  outcome: (r.outcome as Record<string, unknown> | null) ?? null,
});

export const runDto = (
  { run, steps }: RunWithSteps,
  children: RunRow[] = [],
): z.infer<typeof RunDto> => ({
  ...runSummaryDto(run),
  steps: steps.map((st) => ({
    name: st.name,
    position: st.position,
    status: st.status,
    started_at: iso(st.startedAt),
    finished_at: iso(st.finishedAt),
    duration_ms: st.durationMs,
    gap_reason: st.gapReason,
    error: st.error,
    log: st.log,
  })),
  gaps: steps
    .filter((st) => st.status === "skipped")
    .map((st) => ({ step: st.name, reason: st.gapReason ?? "no reason recorded" })),
  children: children.map(runSummaryDto),
});

export const projectDto = (
  p: ProjectRow,
  envs: EnvRow[],
  latest: RunRow | null,
  latestPulseByEnv: Map<string, RunRow> = new Map(),
  openIssues = 0,
  latestScan: RunRow | null = null,
): z.infer<typeof ProjectDto> => ({
  id: p.id,
  org_id: p.orgId,
  name: p.name,
  repo_url: p.repoUrl,
  default_branch: p.defaultBranch,
  platform: p.platform,
  github_repo: p.githubRepo,
  check_on_push: p.checkOnPush,
  environments: envs.map((e) => environmentDto(e, latestPulseByEnv.get(e.id) ?? null)),
  latest_run: latest ? runSummaryDto(latest) : null,
  latest_scan: latestScan
    ? {
        run_id: latestScan.id,
        status: latestScan.status,
        health_score:
          (latestScan.outcome as { health_score?: number | null } | null)?.health_score ?? null,
        finished_at: (latestScan.finishedAt ?? latestScan.createdAt).toISOString(),
      }
    : null,
  open_issues: openIssues,
  created_at: p.createdAt.toISOString(),
  updated_at: p.updatedAt.toISOString(),
});

/** http(s) URL without embedded credentials. SSRF checks happen when Pulse fetches it. */
export const PublicHttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return !u.username && !u.password;
  }, "must not contain credentials");

// --- Pulse: findings, issues, evidence, prompts -------------------------------

export const EvidenceDto = z
  .object({
    id: z.uuid(),
    run_id: z.uuid(),
    kind: z.string(),
    locator: z.string(),
    payload: z.record(z.string(), z.unknown()),
    hash: z.string(),
    created_at: ts,
  })
  .meta({ id: "Evidence" });

export const FindingDto = z
  .object({
    id: z.uuid(),
    run_id: z.uuid(),
    source: z.enum(["scan", "pulse"]),
    code: FindingCode,
    severity: Severity,
    locator: z.string(),
    discriminator: z.string().nullable(),
    message: z.string(),
    fingerprint: z.string(),
    evidence: EvidenceDto,
  })
  .meta({ id: "Finding" });

export const PromptDto = z
  .object({
    type: PromptType,
    body: z.string(),
    template_version: z.string(),
    version: z.number().int().nullable(),
  })
  .meta({ id: "FixPrompt" });

export const RecheckDto = z
  .object({
    module: z.enum(["scan", "pulse"]),
    check_group: z.string(),
    target: z.string(),
    expectation: z.string(),
  })
  .meta({ id: "Recheck" });

export const IssueDto = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    environment_id: z.uuid().nullable(),
    fingerprint: z.string(),
    title: z.string(),
    code: FindingCode,
    corroborating_codes: z.array(z.string()),
    severity: Severity,
    status: IssueStatus,
    locator: z.string(),
    summary: z.string(),
    first_seen_run_id: z.uuid(),
    last_seen_run_id: z.uuid(),
    resolved_run_id: z.uuid().nullable(),
    recheck: RecheckDto,
    dismissed_reason: z.string().nullable(),
    created_at: ts,
    updated_at: ts,
  })
  .meta({ id: "Issue" });

export const IssueDetailDto = IssueDto.extend({
  prompt: PromptDto,
  events: z.array(
    z.object({
      kind: IssueEventKind,
      run_id: z.uuid().nullable(),
      note: z.string().nullable(),
      at: ts,
    }),
  ),
  /** Findings that showed this issue in its latest sighting, with their evidence. */
  observed: z.array(FindingDto),
  /** Verified code locations (Section 10a); empty when Link could not trace it. */
  traces: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().nullable(),
      symbol: z.string().nullable(),
      excerpt: z.string().nullable(),
      join_key: z.string(),
      env_vars: z.array(z.object({ name: z.string(), documented: z.boolean() })),
      run_id: z.uuid(),
    }),
  ),
  /** Files that depend on or change with the traced code, and why (Section 10b). */
  blast_radius: z.array(z.object({ path: z.string(), reason: z.string() })),
}).meta({ id: "IssueDetail" });

/** Findings of one run, grouped into issues with prompts (Quick Pulse runs have no stored issues). */
export const RunFindingsDto = z
  .object({
    run_id: z.uuid(),
    outcome: z.record(z.string(), z.unknown()).nullable(),
    findings: z.array(FindingDto),
    issues: z.array(
      z.object({
        issue_id: z.uuid().nullable(),
        title: z.string(),
        code: FindingCode,
        severity: Severity,
        corroborating_codes: z.array(z.string()),
        finding_ids: z.array(z.uuid()),
        prompt: PromptDto,
        recheck: RecheckDto,
      }),
    ),
  })
  .meta({ id: "RunFindings" });

type EvidenceRow = typeof schema.evidence.$inferSelect;
type FindingRow = typeof schema.findings.$inferSelect;
type IssueRow = typeof schema.issues.$inferSelect;

export const evidenceDto = (e: EvidenceRow): z.infer<typeof EvidenceDto> => ({
  id: e.id,
  run_id: e.runId,
  kind: e.kind,
  locator: e.locator,
  payload: e.payload as Record<string, unknown>,
  hash: e.hash,
  created_at: e.createdAt.toISOString(),
});

export const findingDto = (f: FindingRow, e: EvidenceRow): z.infer<typeof FindingDto> => ({
  id: f.id,
  run_id: f.runId,
  source: f.source,
  code: f.code,
  severity: f.severity,
  locator: f.locator,
  discriminator: f.discriminator,
  message: f.message,
  fingerprint: f.fingerprint,
  evidence: evidenceDto(e),
});

export const issueDto = (i: IssueRow): z.infer<typeof IssueDto> => ({
  id: i.id,
  project_id: i.projectId,
  environment_id: i.environmentId,
  fingerprint: i.fingerprint,
  title: i.title,
  code: i.code,
  corroborating_codes: i.corroboratingCodes,
  severity: i.severity,
  status: i.status,
  locator: i.locator,
  summary: i.summary,
  first_seen_run_id: i.firstSeenRunId,
  last_seen_run_id: i.lastSeenRunId,
  resolved_run_id: i.resolvedRunId,
  recheck: i.recheck as z.infer<typeof RecheckDto>,
  dismissed_reason: i.dismissedReason,
  created_at: i.createdAt.toISOString(),
  updated_at: i.updatedAt.toISOString(),
});

// --- Scan (Phase 3) -----------------------------------------------------------------

export const SnapshotDto = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    kind: z.enum(["git", "zip", "github"]),
    source_url: z.string().nullable(),
    ref: z.string().nullable(),
    commit_sha: z.string().nullable(),
    tree_hash: z.string().nullable().describe("Set once ingest has extracted the tree"),
    has_history: z.boolean(),
    size_bytes: z.number().int().nullable(),
    file_count: z.number().int().nullable(),
    created_at: z.iso.datetime(),
  })
  .meta({ id: "Snapshot" });

type SnapshotRow = typeof schema.snapshots.$inferSelect;
export const snapshotDto = (r: SnapshotRow): z.infer<typeof SnapshotDto> => ({
  id: r.id,
  project_id: r.projectId,
  kind: r.kind,
  source_url: r.sourceUrl,
  ref: r.ref,
  commit_sha: r.commitSha,
  tree_hash: r.treeHash,
  has_history: r.hasHistory,
  size_bytes: r.sizeBytes,
  file_count: r.fileCount,
  created_at: r.createdAt.toISOString(),
});

const ClaimOut = z.object({ text: z.string(), evidence_ids: z.array(z.uuid()) });

export const ReportDto = z
  .object({
    run_id: z.uuid(),
    source_run_id: z
      .uuid()
      .describe(
        "The run whose evidence the report rests on (differs when a cached report is reused)",
      ),
    cached: z.boolean(),
    health: z.object({
      score: z.number().int().nullable(),
      excluded: z
        .array(z.string())
        .describe("Components that could not be measured; weights were renormalized"),
      components: z.array(
        z.object({
          component: z.string(),
          weight: z.number(),
          measured: z.boolean(),
          not_measured: z.array(z.string()),
          ratio: z.number(),
          deductions: z.array(
            z.object({ reason: z.string(), points: z.number(), evidence_ids: z.array(z.uuid()) }),
          ),
        }),
      ),
    }),
    sections: z.object({
      summary: z.array(ClaimOut),
      value: z.array(ClaimOut),
      features: z.array(ClaimOut),
      issues: z.array(ClaimOut),
      remaining: z.array(ClaimOut),
    }),
    features: z.array(
      z.object({
        name: z.string(),
        status: z.enum(["complete", "partial", "planned"]),
        reason: z.string(),
        evidence_ids: z.array(z.uuid()),
      }),
    ),
    claims_total: z.number().int(),
    claims_dropped: z.number().int(),
    dropped_claims: z.array(
      z.object({
        section: z.string(),
        text: z.string(),
        reason: z.string(),
        detail: z.string().nullable(),
        evidence_ids: z.array(z.uuid()),
      }),
    ),
    coverage: z.object({
      gaps: z.array(z.object({ stage: z.string(), reason: z.string() })),
      checks: z.record(z.string(), z.string()),
      stages: z.record(z.string(), z.string()),
    }),
    summary: z.record(z.string(), z.unknown()),
    model: z.string().nullable(),
    created_at: z.iso.datetime(),
  })
  .meta({ id: "ScanReport" });
