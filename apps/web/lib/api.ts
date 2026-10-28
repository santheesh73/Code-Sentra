/** Types mirror the API's DTOs (docs/openapi.json). */
export type Role = "owner" | "admin" | "member";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "partial";
export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}
export interface Org {
  id: string;
  name: string;
  slug: string;
  role: Role;
}
export interface Me {
  user: User;
  organizations: Org[];
}
export interface Member {
  user: User;
  role: Role;
  joined_at: string;
}
export type PulseStatus = "live" | "degraded" | "down" | "unverified";
export type Severity = "error" | "warning" | "info";
export type IssueStatus = "open" | "resolved" | "regressed" | "dismissed";
export type PromptType = "code_fix" | "config_fix" | "outage_triage" | "investigate";
export interface Gap {
  group: string;
  reason: string;
}
export interface Environment {
  id: string;
  name: string;
  url: string;
  created_at: string;
  /** Latest finished Pulse; null until checked (never assumed live). */
  status: { pulse_status: PulseStatus; run_id: string; checked_at: string; gaps: Gap[] } | null;
  /** A bypass token for access-protected previews is stored (never returned). */
  has_bypass_token: boolean;
}
export interface RunSummary {
  id: string;
  org_id: string;
  project_id: string | null;
  environment_id: string | null;
  type: "scan" | "pulse" | "link" | "recheck" | "diagnostic";
  trigger: string;
  status: RunStatus;
  target_url: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  outcome: PulseOutcome | Record<string, unknown> | null;
  /** The Link run this run feeds. */
  parent_run_id: string | null;
}
export interface PulseOutcome {
  pulse_status: PulseStatus;
  gaps: Gap[];
  platform: { name: string; environment: string; reason: string } | null;
  final_url: string | null;
  duration_ms: number;
}
export interface RunStep {
  name: string;
  position: number;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  gap_reason: string | null;
  error: string | null;
  log: string | null;
}
export interface Run extends RunSummary {
  steps: RunStep[];
  gaps: { step: string; reason: string }[];
  /** A Link run's Scan and Pulse runs. */
  children: RunSummary[];
}
export interface LinkOutcome {
  issues: { opened: number; seen: number; resolved: number; regressed: number };
  traced: number;
  untraced: number;
  gaps: string[];
}
export function isLinkOutcome(o: unknown): o is LinkOutcome {
  return typeof o === "object" && o !== null && "traced" in o && "issues" in o;
}
export interface Project {
  id: string;
  org_id: string;
  name: string;
  repo_url: string | null;
  default_branch: string | null;
  platform: string | null;
  /** owner/repo the GitHub App reports check runs for. */
  github_repo: string | null;
  check_on_push: boolean;
  environments: Environment[];
  latest_run: RunSummary | null;
  /** The latest finished Scan; null until one has run. */
  latest_scan: {
    run_id: string;
    status: RunStatus;
    health_score: number | null;
    finished_at: string;
  } | null;
  open_issues: number;
  created_at: string;
  updated_at: string;
}
export interface Evidence {
  id: string;
  run_id: string;
  kind: string;
  locator: string;
  payload: Record<string, unknown>;
  hash: string;
  created_at: string;
}
export interface Finding {
  id: string;
  run_id: string;
  source: "scan" | "pulse";
  code: string;
  severity: Severity;
  locator: string;
  discriminator: string | null;
  message: string;
  fingerprint: string;
  evidence: Evidence;
}
export interface Prompt {
  type: PromptType;
  body: string;
  template_version: string;
  version: number | null;
}
export interface Recheck {
  module: "scan" | "pulse";
  check_group: string;
  target: string;
  expectation: string;
}
export interface Issue {
  id: string;
  project_id: string;
  environment_id: string | null;
  fingerprint: string;
  title: string;
  code: string;
  corroborating_codes: string[];
  severity: Severity;
  status: IssueStatus;
  locator: string;
  summary: string;
  first_seen_run_id: string;
  last_seen_run_id: string;
  resolved_run_id: string | null;
  recheck: Recheck;
  dismissed_reason: string | null;
  created_at: string;
  updated_at: string;
}
export interface Trace {
  path: string;
  line: number | null;
  symbol: string | null;
  excerpt: string | null;
  join_key: string;
  env_vars: { name: string; documented: boolean }[];
  run_id: string;
}
export interface IssueDetail extends Issue {
  prompt: Prompt;
  events: { kind: string; run_id: string | null; note: string | null; at: string }[];
  observed: Finding[];
  /** Verified code locations; empty when Link could not trace it (never a guess). */
  traces: Trace[];
  blast_radius: { path: string; reason: string }[];
}
export interface RunFindings {
  run_id: string;
  outcome: PulseOutcome | null;
  findings: Finding[];
  issues: {
    issue_id: string | null;
    title: string;
    code: string;
    severity: Severity;
    corroborating_codes: string[];
    finding_ids: string[];
    prompt: Prompt;
    recheck: Recheck;
  }[];
}

export function isPulseOutcome(o: unknown): o is PulseOutcome {
  return typeof o === "object" && o !== null && "pulse_status" in o;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
  get status() {
    return this.problem.status;
  }
}

/** Browser-side client: same-origin `/api/*` is proxied to the API with the session cookie. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const p = (data ?? {}) as Partial<Problem>;
    throw new ApiError({
      type: p.type ?? "about:blank",
      title: p.title ?? res.statusText,
      status: res.status,
      detail: p.detail,
      errors: p.errors,
    });
  }
  return data as T;
}

export function problemMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const fields = e.problem.errors?.map((x) => `${x.path.replace(/^body\//, "")}: ${x.message}`);
    return fields?.length ? `${e.message} (${fields.join("; ")})` : e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

export type FeatureStatus = "complete" | "partial" | "planned";
export interface Snapshot {
  id: string;
  project_id: string;
  kind: "git" | "zip";
  source_url: string | null;
  ref: string | null;
  commit_sha: string | null;
  tree_hash: string | null;
  has_history: boolean;
  size_bytes: number | null;
  file_count: number | null;
  created_at: string;
}
export interface ReportClaim {
  text: string;
  evidence_ids: string[];
}
export interface ScanReport {
  run_id: string;
  source_run_id: string;
  cached: boolean;
  health: {
    score: number | null;
    excluded: string[];
    components: {
      component: string;
      weight: number;
      measured: boolean;
      not_measured: string[];
      ratio: number;
      deductions: { reason: string; points: number; evidence_ids: string[] }[];
    }[];
  };
  sections: Record<"summary" | "value" | "features" | "issues" | "remaining", ReportClaim[]>;
  features: { name: string; status: FeatureStatus; reason: string; evidence_ids: string[] }[];
  claims_total: number;
  claims_dropped: number;
  dropped_claims: {
    section: string;
    text: string;
    reason: string;
    detail: string | null;
    evidence_ids: string[];
  }[];
  coverage: {
    gaps: { stage: string; reason: string }[];
    checks: Record<string, string>;
    stages: Record<string, string>;
  };
  summary: Record<string, unknown>;
  model: string | null;
  created_at: string;
}
export interface ScanOutcome {
  cached: boolean;
  source_run_id?: string;
  health_score?: number | null;
  features?: Record<FeatureStatus, number>;
  claims?: { total: number; dropped: number };
}

export function isScanOutcome(o: unknown): o is ScanOutcome {
  return typeof o === "object" && o !== null && "cached" in o;
}

/** Uploads a zip as the raw request body (ADR 0018). */
export async function uploadZip(projectId: string, file: File): Promise<Snapshot> {
  const res = await fetch(`/api/v1/projects/${projectId}/snapshots`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: file,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as Partial<Problem> & Snapshot;
  if (!res.ok)
    throw new ApiError({
      type: data.type ?? "about:blank",
      title: data.title ?? res.statusText,
      status: res.status,
      detail:
        data.detail ??
        (res.status === 413 ? "The zip is larger than this server accepts" : undefined),
    });
  return data;
}

export interface Schedule {
  id: string;
  project_id: string;
  environment_id: string;
  cron: string;
  run_type: "pulse" | "check";
  enabled: boolean;
  next_run_at: string;
  last_run_id: string | null;
  last_run_at: string | null;
  last_error: string | null;
  created_at: string;
}
export interface NotificationChannel {
  id: string;
  project_id: string;
  kind: "email" | "slack";
  label: string;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
}
export interface ApiToken {
  id: string;
  org_id: string;
  name: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}
export interface GithubInstallations {
  configured: boolean;
  installations: {
    installation_id: number;
    account: string | null;
    repositories: string[];
    suspended: boolean;
  }[];
}
export interface AuditEntry {
  id: string;
  actor_id: string | null;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
