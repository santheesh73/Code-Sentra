import {
  CodeEdgeKind,
  CodeNodeKind,
  EvidenceKind,
  FeatureStatus,
  FindingCode,
  IssueEventKind,
  IssueStatus,
  MembershipRole,
  Module,
  PromptType,
  RunStatus,
  RunStepStatus,
  RunTrigger,
  RunType,
  Severity,
  SnapshotKind,
} from "@codesentra/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const values = <T extends string>(options: readonly T[]) => options as [T, ...T[]];

export const membershipRole = pgEnum("membership_role", values(MembershipRole.options));
export const runType = pgEnum("run_type", values(RunType.options));
export const runTrigger = pgEnum("run_trigger", values(RunTrigger.options));
export const runStatus = pgEnum("run_status", values(RunStatus.options));
export const runStepStatus = pgEnum("run_step_status", values(RunStepStatus.options));
export const evidenceKind = pgEnum("evidence_kind", values(EvidenceKind.options));
export const findingSource = pgEnum("finding_source", values(Module.options));
export const findingCode = pgEnum("finding_code", values(FindingCode.options));
export const severity = pgEnum("severity", values(Severity.options));
export const issueStatus = pgEnum("issue_status", values(IssueStatus.options));
export const issueEventKind = pgEnum("issue_event_kind", values(IssueEventKind.options));
export const promptType = pgEnum("prompt_type", values(PromptType.options));
export const snapshotKind = pgEnum("snapshot_kind", values(SnapshotKind.options));
export const codeNodeKind = pgEnum("code_node_kind", values(CodeNodeKind.options));
export const codeEdgeKind = pgEnum("code_edge_kind", values(CodeEdgeKind.options));
export const featureStatus = pgEnum("feature_status", values(FeatureStatus.options));

// --- Identity (not tenant-owned) -------------------------------------------------

export const users = pgTable(
  "users",
  {
    ...base,
    /** Stored lower-cased. */
    email: text("email").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    ...base,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    providerLogin: text("provider_login"),
  },
  (t) => [unique("auth_identities_provider_key").on(t.provider, t.providerUserId)],
);

export const sessions = pgTable(
  "sessions",
  {
    ...base,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 of the cookie token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: tz("expires_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_hash_key").on(t.tokenHash), index().on(t.userId)],
);

export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    ...base,
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tz("expires_at").notNull(),
    consumedAt: tz("consumed_at"),
  },
  (t) => [uniqueIndex("magic_link_tokens_token_hash_key").on(t.tokenHash), index().on(t.email)],
);

// --- Tenancy ---------------------------------------------------------------------

export const organizations = pgTable(
  "organizations",
  {
    ...base,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull().default("free"),
  },
  (t) => [uniqueIndex("organizations_slug_key").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    ...base,
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
  },
  (t) => [unique("memberships_org_user_key").on(t.orgId, t.userId), index().on(t.userId)],
);

export const projects = pgTable(
  "projects",
  {
    ...base,
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repoUrl: text("repo_url"),
    defaultBranch: text("default_branch"),
    platform: text("platform"),
    /** `owner/repo` the org's GitHub App installation covers (Section 16). */
    githubRepo: text("github_repo"),
    /** Run a full check on every push to the default branch. */
    checkOnPush: boolean("check_on_push").notNull().default(false),
  },
  (t) => [
    unique("projects_org_id_id_key").on(t.orgId, t.id),
    unique("projects_org_github_repo_key").on(t.orgId, t.githubRepo),
    index().on(t.orgId),
  ],
);

export const environments = pgTable(
  "environments",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** Reference to an encrypted secret; never the token itself. */
    bypassTokenRef: text("bypass_token_ref"),
  },
  (t) => [
    foreignKey({
      name: "environments_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }).onDelete("cascade"),
    unique("environments_project_name_key").on(t.projectId, t.name),
    unique("environments_org_id_id_key").on(t.orgId, t.id),
  ],
);

export const runs = pgTable(
  "runs",
  {
    ...base,
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    type: runType("type").notNull(),
    trigger: runTrigger("trigger").notNull(),
    parentRunId: uuid("parent_run_id"),
    snapshotId: uuid("snapshot_id"),
    environmentId: uuid("environment_id"),
    targetUrl: text("target_url"),
    status: runStatus("status").notNull().default("queued"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: tz("started_at"),
    finishedAt: tz("finished_at"),
    error: text("error"),
    /** Module-specific result summary, e.g. { pulse_status, gaps, platform, final_url } for Pulse. */
    outcome: jsonb("outcome"),
  },
  (t) => [
    foreignKey({
      name: "runs_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "runs_snapshot_fk",
      columns: [t.orgId, t.snapshotId],
      foreignColumns: [snapshots.orgId, snapshots.id],
    }).onDelete("set null"),
    foreignKey({
      name: "runs_environment_fk",
      columns: [t.orgId, t.environmentId],
      foreignColumns: [environments.orgId, environments.id],
    }).onDelete("set null"),
    unique("runs_org_id_id_key").on(t.orgId, t.id),
    index().on(t.projectId, t.createdAt),
  ],
);

export const runSteps = pgTable(
  "run_steps",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    status: runStepStatus("status").notNull().default("pending"),
    startedAt: tz("started_at"),
    finishedAt: tz("finished_at"),
    durationMs: integer("duration_ms"),
    /** Required when status is skipped (Rule 2). */
    gapReason: text("gap_reason"),
    error: text("error"),
    /** Short, capped step log; never secrets or user code beyond stored evidence. */
    log: text("log"),
  },
  (t) => [
    foreignKey({
      name: "run_steps_run_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
    unique("run_steps_run_name_key").on(t.runId, t.name),
    check(
      "run_steps_skipped_has_reason",
      sql`${t.status} <> 'skipped' OR ${t.gapReason} IS NOT NULL`,
    ),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    ...base,
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

// --- Evidence, findings, issues (Phase 2) ---------------------------------------

/** Rule 3: Scan and Pulse write to this one table. Payloads never contain secrets. */
export const evidence = pgTable(
  "evidence",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    kind: evidenceKind("kind").notNull(),
    locator: text("locator").notNull(),
    payload: jsonb("payload").notNull(),
    /** sha256 of kind + locator + canonical payload. */
    hash: text("hash").notNull(),
  },
  (t) => [
    foreignKey({
      name: "evidence_run_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
    unique("evidence_org_id_id_key").on(t.orgId, t.id),
    index().on(t.runId),
  ],
);

export const findings = pgTable(
  "findings",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    source: findingSource("source").notNull(),
    code: findingCode("code").notNull(),
    severity: severity("severity").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    locator: text("locator").notNull(),
    discriminator: text("discriminator"),
    message: text("message").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [
    foreignKey({
      name: "findings_run_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "findings_evidence_fk",
      columns: [t.orgId, t.evidenceId],
      foreignColumns: [evidence.orgId, evidence.id],
    }).onDelete("cascade"),
    unique("findings_org_id_id_key").on(t.orgId, t.id),
    index().on(t.runId),
  ],
);

export const issues = pgTable(
  "issues",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    /** Pulse issues belong to the environment whose URL showed them. */
    environmentId: uuid("environment_id"),
    fingerprint: text("fingerprint").notNull(),
    title: text("title").notNull(),
    code: findingCode("code").notNull(),
    /** Codes of findings merged into this issue because they share evidence (Section 10c). */
    corroboratingCodes: text("corroborating_codes").array().notNull().default(sql`'{}'::text[]`),
    severity: severity("severity").notNull(),
    status: issueStatus("status").notNull().default("open"),
    locator: text("locator").notNull(),
    summary: text("summary").notNull(),
    firstSeenRunId: uuid("first_seen_run_id").notNull(),
    lastSeenRunId: uuid("last_seen_run_id").notNull(),
    resolvedRunId: uuid("resolved_run_id"),
    /** { module, check_group, target, expectation } (Section 10d). */
    recheck: jsonb("recheck").notNull(),
    dismissedReason: text("dismissed_reason"),
  },
  (t) => [
    foreignKey({
      name: "issues_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "issues_environment_fk",
      columns: [t.orgId, t.environmentId],
      foreignColumns: [environments.orgId, environments.id],
    }).onDelete("cascade"),
    unique("issues_project_fingerprint_key").on(t.projectId, t.fingerprint),
    unique("issues_org_id_id_key").on(t.orgId, t.id),
    index().on(t.projectId, t.status),
  ],
);

export const issueEvents = pgTable(
  "issue_events",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id"),
    kind: issueEventKind("kind").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
  },
  (t) => [
    foreignKey({
      name: "issue_events_issue_fk",
      columns: [t.orgId, t.issueId],
      foreignColumns: [issues.orgId, issues.id],
    }).onDelete("cascade"),
    index().on(t.issueId, t.createdAt),
  ],
);

/** Links an issue to the findings that showed it in each run. */
export const issueFindings = pgTable(
  "issue_findings",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    findingId: uuid("finding_id").notNull(),
  },
  (t) => [
    foreignKey({
      name: "issue_findings_issue_fk",
      columns: [t.orgId, t.issueId],
      foreignColumns: [issues.orgId, issues.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "issue_findings_finding_fk",
      columns: [t.orgId, t.findingId],
      foreignColumns: [findings.orgId, findings.id],
    }).onDelete("cascade"),
    unique("issue_findings_key").on(t.issueId, t.findingId),
  ],
);

export const fixPrompts = pgTable(
  "fix_prompts",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    version: integer("version").notNull(),
    type: promptType("type").notNull(),
    body: text("body").notNull(),
    blastRadius: jsonb("blast_radius").notNull().default([]),
    templateVersion: text("template_version").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fix_prompts_issue_fk",
      columns: [t.orgId, t.issueId],
      foreignColumns: [issues.orgId, issues.id],
    }).onDelete("cascade"),
    unique("fix_prompts_issue_version_key").on(t.issueId, t.version),
  ],
);

// --- Scan (Phase 3) ------------------------------------------------------------------

/** An ingested tree: a zip upload or a git clone, archived in object storage. */
export const snapshots = pgTable(
  "snapshots",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    kind: snapshotKind("kind").notNull(),
    /** Git: the URL and ref requested; null for zips. */
    sourceUrl: text("source_url"),
    ref: text("ref"),
    commitSha: text("commit_sha"),
    /** Set once ingest has extracted the tree; content identity for cache reuse. */
    treeHash: text("tree_hash"),
    hasHistory: boolean("has_history").notNull().default(false),
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes"),
    fileCount: integer("file_count"),
    /** kind github: fetched as the repository zipball with this installation's token. */
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
  },
  (t) => [
    foreignKey({
      name: "snapshots_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }).onDelete("cascade"),
    unique("snapshots_org_id_id_key").on(t.orgId, t.id),
    index().on(t.projectId, t.treeHash),
  ],
);

export const codeNodes = pgTable(
  "code_nodes",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    /** Stable key within the snapshot (`file:src/a.ts`, `env:PORT`). */
    key: text("key").notNull(),
    kind: codeNodeKind("kind").notNull(),
    path: text("path"),
    name: text("name").notNull(),
    line: integer("line"),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => [
    foreignKey({
      name: "code_nodes_snapshot_fk",
      columns: [t.orgId, t.snapshotId],
      foreignColumns: [snapshots.orgId, snapshots.id],
    }).onDelete("cascade"),
    unique("code_nodes_org_id_id_key").on(t.orgId, t.id),
    unique("code_nodes_snapshot_key_key").on(t.snapshotId, t.key),
  ],
);

export const codeEdges = pgTable(
  "code_edges",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    fromId: uuid("from_id").notNull(),
    toId: uuid("to_id").notNull(),
    kind: codeEdgeKind("kind").notNull(),
    weight: integer("weight").notNull().default(1),
  },
  (t) => [
    foreignKey({
      name: "code_edges_snapshot_fk",
      columns: [t.orgId, t.snapshotId],
      foreignColumns: [snapshots.orgId, snapshots.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "code_edges_from_fk",
      columns: [t.orgId, t.fromId],
      foreignColumns: [codeNodes.orgId, codeNodes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "code_edges_to_fk",
      columns: [t.orgId, t.toId],
      foreignColumns: [codeNodes.orgId, codeNodes.id],
    }).onDelete("cascade"),
    index().on(t.snapshotId, t.kind),
  ],
);

/**
 * Verified code locations for an issue (Section 10a), replaced on every Link run that
 * re-traces it. `code_node_id` survives as null when a later Scan drops the node.
 */
export const traces = pgTable(
  "traces",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    /** The leading finding the join key came from. */
    findingId: uuid("finding_id").references(() => findings.id, { onDelete: "set null" }),
    codeNodeId: uuid("code_node_id").references(() => codeNodes.id, { onDelete: "set null" }),
    /** The Link run that wrote it. */
    runId: uuid("run_id").notNull(),
    joinKey: text("join_key").notNull(),
    verified: boolean("verified").notNull(),
    path: text("path").notNull(),
    line: integer("line"),
    symbol: text("symbol"),
    excerpt: text("excerpt"),
    /** [{ name, documented }] for env vars interpolated at the site. */
    envVars: jsonb("env_vars").notNull().default([]),
  },
  (t) => [
    foreignKey({
      name: "traces_issue_fk",
      columns: [t.orgId, t.issueId],
      foreignColumns: [issues.orgId, issues.id],
    }).onDelete("cascade"),
    // Never stored unverified (Rule 1): an untraced issue simply has no rows.
    check("traces_verified", sql`${t.verified}`),
    index().on(t.issueId),
  ],
);

export const features = pgTable(
  "features",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    runId: uuid("run_id").notNull(),
    name: text("name").notNull(),
    status: featureStatus("status").notNull(),
    reason: text("reason").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull(),
  },
  (t) => [
    foreignKey({
      name: "features_snapshot_fk",
      columns: [t.orgId, t.snapshotId],
      foreignColumns: [snapshots.orgId, snapshots.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "features_run_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
    index().on(t.runId),
  ],
);

export const reports = pgTable(
  "reports",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    /** Verified claims by section, in order: { summary: [{ text, evidence_ids }], … }. */
    sections: jsonb("sections").notNull(),
    healthScore: integer("health_score"),
    healthBreakdown: jsonb("health_breakdown").notNull(),
    claimsTotal: integer("claims_total").notNull(),
    claimsDropped: integer("claims_dropped").notNull(),
    /** Stages and checks that did not run, with reasons (Rule 2). */
    coverage: jsonb("coverage").notNull(),
    /** Map summary: languages, frameworks, routes, env vars, probe results. */
    summary: jsonb("summary").notNull(),
    model: text("model"),
    usage: jsonb("usage").notNull().default([]),
  },
  (t) => [
    foreignKey({
      name: "reports_run_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
    unique("reports_org_id_id_key").on(t.orgId, t.id),
    unique("reports_run_key").on(t.runId),
  ],
);

export const claims = pgTable(
  "claims",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    reportId: uuid("report_id").notNull(),
    position: integer("position").notNull(),
    section: text("section").notNull(),
    text: text("text").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull(),
    verified: boolean("verified").notNull(),
    dropReason: text("drop_reason"),
    dropDetail: text("drop_detail"),
  },
  (t) => [
    foreignKey({
      name: "claims_report_fk",
      columns: [t.orgId, t.reportId],
      foreignColumns: [reports.orgId, reports.id],
    }).onDelete("cascade"),
    index().on(t.reportId),
    check("claims_dropped_has_reason", sql`${t.verified} OR ${t.dropReason} IS NOT NULL`),
  ],
);

/** Tables with an `org_id` column, protected by the tenant RLS policy. */
/**
 * GitHub App installations. The installation webhook can arrive before anyone links it
 * to an org, so `org_id` is null until the setup callback does (with a signed state).
 * The account and repository list are sealed at rest (Section 17).
 */
export const githubInstallations = pgTable("github_installations", {
  ...base,
  installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
  /** sealSecret(JSON { account, repositories }) with purpose "github-installation". */
  sealed: text("sealed").notNull(),
  suspended: boolean("suspended").notNull().default(false),
});

/** Every webhook delivery, once (X-GitHub-Delivery is unique): replays are no-ops. */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  ...base,
  provider: text("provider").notNull(),
  deliveryId: text("delivery_id").notNull().unique(),
  event: text("event").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
});

/** The CodeSentra check run of one commit (Section 16: matched by head SHA). */
export const githubCheckRuns = pgTable(
  "github_check_runs",
  {
    ...base,
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repo: text("repo").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha"),
    prNumber: integer("pr_number"),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    /** GitHub's id; null until it could be created. */
    checkRunId: bigint("check_run_id", { mode: "number" }),
    /** The commit's Scan (Link traces the deployment's Pulse against it). */
    scanRunId: uuid("scan_run_id"),
    /** The latest Link run reporting into this check run. */
    linkRunId: uuid("link_run_id"),
    changedFiles: text("changed_files").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    foreignKey({
      name: "github_check_runs_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }).onDelete("cascade"),
    unique("github_check_runs_project_sha_key").on(t.projectId, t.headSha),
    index().on(t.linkRunId),
  ],
);

export const TENANT_TABLES = [
  "memberships",
  "projects",
  "environments",
  "runs",
  "run_steps",
  "audit_log",
  "evidence",
  "findings",
  "issues",
  "issue_events",
  "issue_findings",
  "fix_prompts",
  "snapshots",
  "code_nodes",
  "code_edges",
  "features",
  "reports",
  "claims",
  "traces",
  "github_check_runs",
] as const;
