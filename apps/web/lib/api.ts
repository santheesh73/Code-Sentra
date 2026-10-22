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
}
export interface Project {
  id: string;
  org_id: string;
  name: string;
  repo_url: string | null;
  default_branch: string | null;
  platform: string | null;
  environments: Environment[];
  latest_run: RunSummary | null;
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
export interface IssueDetail extends Issue {
  prompt: Prompt;
  events: { kind: string; run_id: string | null; note: string | null; at: string }[];
  observed: Finding[];
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
