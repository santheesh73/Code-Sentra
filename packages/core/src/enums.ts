import { z } from "zod";

export const Severity = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof Severity>;

export const Module = z.enum(["scan", "pulse"]);
export type Module = z.infer<typeof Module>;

export const RunType = z.enum(["scan", "pulse", "link", "recheck"]);
export type RunType = z.infer<typeof RunType>;

export const RunTrigger = z.enum(["manual", "webhook", "schedule", "cli"]);
export type RunTrigger = z.infer<typeof RunTrigger>;

export const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "partial"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunStepStatus = z.enum(["pending", "running", "done", "skipped", "failed"]);
export type RunStepStatus = z.infer<typeof RunStepStatus>;

export const IssueStatus = z.enum(["open", "resolved", "regressed", "dismissed"]);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const IssueEventKind = z.enum(["opened", "seen", "resolved", "regressed", "dismissed"]);
export type IssueEventKind = z.infer<typeof IssueEventKind>;

export const PromptType = z.enum(["code_fix", "config_fix", "outage_triage", "investigate"]);
export type PromptType = z.infer<typeof PromptType>;

export const FeatureStatus = z.enum(["complete", "partial", "planned"]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const PulseStatus = z.enum(["live", "degraded", "down", "unverified"]);
export type PulseStatus = z.infer<typeof PulseStatus>;

export const MembershipRole = z.enum(["owner", "admin", "member"]);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const SnapshotKind = z.enum(["git", "zip"]);
export type SnapshotKind = z.infer<typeof SnapshotKind>;

export const JobType = z.enum([
  "scan.run",
  "scan.incremental",
  "pulse.run",
  "link.run",
  "issue.recheck",
  "schedule.tick",
]);
export type JobType = z.infer<typeof JobType>;

/** Pulse check groups (Section 9). */
export const PulseCheckGroup = z.enum(["reachability", "platform", "render", "routes", "hygiene"]);
export type PulseCheckGroup = z.infer<typeof PulseCheckGroup>;

/** Scan pipeline stages (Section 8); each is a run_step. */
export const ScanStage = z.enum(["ingest", "map", "history", "probe", "inventory", "explain"]);
export type ScanStage = z.infer<typeof ScanStage>;

/** Scan probes that can be re-checked individually. */
export const ScanCheckGroup = z.enum([
  "build",
  "tests",
  "typecheck",
  "lint",
  "dependency_audit",
  "secrets",
  "map",
  "history",
  "inventory",
]);
export type ScanCheckGroup = z.infer<typeof ScanCheckGroup>;

export const CodeNodeKind = z.enum([
  "file",
  "symbol",
  "route",
  "api_handler",
  "cli_command",
  "env_var",
  "test",
]);
export type CodeNodeKind = z.infer<typeof CodeNodeKind>;

export const CodeEdgeKind = z.enum([
  "imports",
  "calls",
  "defines_route",
  "reads_env",
  "tests",
  "co_changes",
]);
export type CodeEdgeKind = z.infer<typeof CodeEdgeKind>;
