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
export interface Environment {
  id: string;
  name: string;
  url: string;
  created_at: string;
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
  created_at: string;
  updated_at: string;
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
