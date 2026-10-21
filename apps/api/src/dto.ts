import { MembershipRole, RunStatus, RunStepStatus, RunTrigger, RunType } from "@codesentra/core";
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

export const EnvironmentDto = z
  .object({ id: z.uuid(), name: z.string(), url: z.url(), created_at: ts })
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
    error: z.string().nullable(),
    created_at: ts,
    started_at: ts.nullable(),
    finished_at: ts.nullable(),
  })
  .meta({ id: "RunSummary" });

export const RunDto = RunSummaryDto.extend({
  steps: z.array(RunStepDto),
  /** Every step that did not run, with its reason (Rule 2). */
  gaps: z.array(z.object({ step: z.string(), reason: z.string() })),
}).meta({ id: "Run" });

export const ProjectDto = z
  .object({
    id: z.uuid(),
    org_id: z.uuid(),
    name: z.string(),
    repo_url: z.string().nullable(),
    default_branch: z.string().nullable(),
    platform: z.string().nullable(),
    environments: z.array(EnvironmentDto),
    latest_run: RunSummaryDto.nullable(),
    created_at: ts,
    updated_at: ts,
  })
  .meta({ id: "Project" });

export const RunAccepted = z.object({ run_id: z.uuid() }).meta({ id: "RunAccepted" });

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

export const environmentDto = (e: EnvRow): z.infer<typeof EnvironmentDto> => ({
  id: e.id,
  name: e.name,
  url: e.url,
  created_at: e.createdAt.toISOString(),
});

export const runSummaryDto = (r: RunRow): z.infer<typeof RunSummaryDto> => ({
  id: r.id,
  org_id: r.orgId,
  project_id: r.projectId,
  environment_id: r.environmentId,
  type: r.type,
  trigger: r.trigger,
  status: r.status,
  target_url: r.targetUrl,
  error: r.error,
  created_at: r.createdAt.toISOString(),
  started_at: iso(r.startedAt),
  finished_at: iso(r.finishedAt),
});

export const runDto = ({ run, steps }: RunWithSteps): z.infer<typeof RunDto> => ({
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
});

export const projectDto = (
  p: ProjectRow,
  envs: EnvRow[],
  latest: RunRow | null,
): z.infer<typeof ProjectDto> => ({
  id: p.id,
  org_id: p.orgId,
  name: p.name,
  repo_url: p.repoUrl,
  default_branch: p.defaultBranch,
  platform: p.platform,
  environments: envs.map(environmentDto),
  latest_run: latest ? runSummaryDto(latest) : null,
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
