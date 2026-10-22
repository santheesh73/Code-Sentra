ALTER TYPE "public"."snapshot_kind" ADD VALUE 'github';--> statement-breakpoint
CREATE TABLE "github_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"pr_number" integer,
	"installation_id" bigint NOT NULL,
	"check_run_id" bigint,
	"scan_run_id" uuid,
	"link_run_id" uuid,
	"changed_files" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "github_check_runs_project_sha_key" UNIQUE("project_id","head_sha")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installation_id" bigint NOT NULL,
	"org_id" uuid,
	"sealed" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	CONSTRAINT "webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repo" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "check_on_push" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "github_installation_id" bigint;--> statement-breakpoint
ALTER TABLE "github_check_runs" ADD CONSTRAINT "github_check_runs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_check_runs_link_run_id_index" ON "github_check_runs" USING btree ("link_run_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_github_repo_key" UNIQUE("org_id","github_repo");