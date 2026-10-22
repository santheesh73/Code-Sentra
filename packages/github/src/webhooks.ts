import { z } from "zod";

const Repository = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().optional(),
  html_url: z.string().optional(),
});
const Installation = z.object({ id: z.number().int().positive() });
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const InstallationEvent = z.looseObject({
  action: z.string(),
  installation: z.looseObject({
    id: z.number().int().positive(),
    account: z.looseObject({ login: z.string() }),
  }),
  repositories: z.array(z.looseObject({ full_name: z.string() })).optional(),
});
export const InstallationRepositoriesEvent = z.looseObject({
  action: z.string(),
  installation: Installation.loose(),
  repositories_added: z.array(z.looseObject({ full_name: z.string() })).default([]),
  repositories_removed: z.array(z.looseObject({ full_name: z.string() })).default([]),
});
export const PullRequestEvent = z.looseObject({
  action: z.string(),
  number: z.number().int(),
  pull_request: z.looseObject({
    head: z.looseObject({ sha: Sha, ref: z.string() }),
    base: z.looseObject({ sha: Sha, ref: z.string() }),
    html_url: z.string().optional(),
  }),
  repository: Repository.loose(),
  installation: Installation.loose(),
});
export const DeploymentStatusEvent = z.looseObject({
  deployment_status: z.looseObject({
    state: z.string(),
    target_url: z.string().nullish(),
    environment_url: z.string().nullish(),
  }),
  deployment: z.looseObject({ sha: Sha, environment: z.string(), ref: z.string().optional() }),
  repository: Repository.loose(),
  installation: Installation.loose(),
});
export const PushEvent = z.looseObject({
  ref: z.string(),
  after: Sha,
  deleted: z.boolean().optional(),
  repository: Repository.loose(),
  installation: Installation.loose(),
});

export type PullRequestEvent = z.infer<typeof PullRequestEvent>;
export type DeploymentStatusEvent = z.infer<typeof DeploymentStatusEvent>;
export type PushEvent = z.infer<typeof PushEvent>;

/** Section 16 conclusion rule for a check run that carries a Pulse result. */
export function conclusionFor(
  pulseStatus: "live" | "degraded" | "down" | "unverified" | null,
  newErrorIssues: number,
): "success" | "failure" | "neutral" {
  if (pulseStatus === "down" || pulseStatus === "degraded") return "failure";
  if (newErrorIssues > 0) return "failure";
  if (pulseStatus === "unverified") return "neutral";
  return "success";
}
