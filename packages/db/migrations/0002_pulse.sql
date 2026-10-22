CREATE TYPE "public"."evidence_kind" AS ENUM('manifest', 'doc_excerpt', 'code_fact', 'route', 'env_var_read', 'env_var_documented', 'marker', 'test_result', 'probe_result', 'dependency_advisory', 'secret_match', 'commit_stats', 'hotspot', 'language_coverage', 'dns_result', 'tls_certificate', 'http_response', 'redirect_chain', 'platform_identity', 'browser_request', 'console_message', 'page_error', 'render_summary', 'screenshot', 'security_headers');--> statement-breakpoint
CREATE TYPE "public"."finding_code" AS ENUM('BUILD_FAILED', 'TESTS_FAILING', 'TYPECHECK_ERRORS', 'LINT_ERRORS', 'VULNERABLE_DEPENDENCY', 'SECRET_EXPOSED', 'ENV_VAR_UNDOCUMENTED', 'ENV_VAR_UNUSED', 'TODO_MARKER', 'STUB_IMPLEMENTATION', 'SKIPPED_TESTS', 'HOTSPOT', 'NO_TESTS', 'MISSING_BUILD_SCRIPT', 'DOCUMENTED_FEATURE_MISSING', 'DOWN', 'DNS_FAILURE', 'TLS_INVALID', 'TLS_EXPIRING', 'TIMEOUT', 'SERVER_ERROR', 'BAD_STATUS', 'REDIRECT_LOOP', 'LONG_REDIRECT_CHAIN', 'SLOW_RESPONSE', 'ACCESS_PROTECTED', 'PREVIEW_SERVED_AS_PROD', 'UNDEFINED_IN_URL', 'LOCALHOST_CALL', 'SAME_ORIGIN_FAILURE', 'CONSOLE_ERROR', 'UNCAUGHT_EXCEPTION', 'BLANK_PAGE', 'ROUTE_BROKEN', 'ROUTE_MISSING', 'MIXED_CONTENT', 'MISSING_SECURITY_HEADER');--> statement-breakpoint
CREATE TYPE "public"."finding_source" AS ENUM('scan', 'pulse');--> statement-breakpoint
CREATE TYPE "public"."issue_event_kind" AS ENUM('opened', 'seen', 'resolved', 'regressed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'resolved', 'regressed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."prompt_type" AS ENUM('code_fix', 'config_fix', 'outage_triage', 'investigate');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('error', 'warning', 'info');--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"locator" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "evidence_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "finding_source" NOT NULL,
	"code" "finding_code" NOT NULL,
	"severity" "severity" NOT NULL,
	"evidence_id" uuid NOT NULL,
	"locator" text NOT NULL,
	"discriminator" text,
	"message" text NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "findings_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "fix_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"type" "prompt_type" NOT NULL,
	"body" text NOT NULL,
	"blast_radius" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template_version" text NOT NULL,
	CONSTRAINT "fix_prompts_issue_version_key" UNIQUE("issue_id","version")
);
--> statement-breakpoint
CREATE TABLE "issue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" "issue_event_kind" NOT NULL,
	"actor_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "issue_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	CONSTRAINT "issue_findings_key" UNIQUE("issue_id","finding_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"code" "finding_code" NOT NULL,
	"corroborating_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"severity" "severity" NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"locator" text NOT NULL,
	"summary" text NOT NULL,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	"resolved_run_id" uuid,
	"recheck" jsonb NOT NULL,
	"dismissed_reason" text,
	CONSTRAINT "issues_project_fingerprint_key" UNIQUE("project_id","fingerprint"),
	CONSTRAINT "issues_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_evidence_fk" FOREIGN KEY ("org_id","evidence_id") REFERENCES "public"."evidence"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_prompts" ADD CONSTRAINT "fix_prompts_issue_fk" FOREIGN KEY ("org_id","issue_id") REFERENCES "public"."issues"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_events" ADD CONSTRAINT "issue_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_events" ADD CONSTRAINT "issue_events_issue_fk" FOREIGN KEY ("org_id","issue_id") REFERENCES "public"."issues"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_findings" ADD CONSTRAINT "issue_findings_issue_fk" FOREIGN KEY ("org_id","issue_id") REFERENCES "public"."issues"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_findings" ADD CONSTRAINT "issue_findings_finding_fk" FOREIGN KEY ("org_id","finding_id") REFERENCES "public"."findings"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_environment_fk" FOREIGN KEY ("org_id","environment_id") REFERENCES "public"."environments"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_run_id_index" ON "evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "findings_run_id_index" ON "findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "issue_events_issue_id_created_at_index" ON "issue_events" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issues_project_id_status_index" ON "issues" USING btree ("project_id","status");