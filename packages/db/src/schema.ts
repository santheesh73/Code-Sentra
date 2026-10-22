import { MembershipRole, RunStatus, RunStepStatus, RunTrigger, RunType } from "@codesentra/core";
import { sql } from "drizzle-orm";
import {
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
  },
  (t) => [unique("projects_org_id_id_key").on(t.orgId, t.id), index().on(t.orgId)],
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
  },
  (t) => [
    foreignKey({
      name: "runs_project_fk",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }).onDelete("cascade"),
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

/** Tables with an `org_id` column, protected by the tenant RLS policy. */
export const TENANT_TABLES = [
  "memberships",
  "projects",
  "environments",
  "runs",
  "run_steps",
  "audit_log",
] as const;
