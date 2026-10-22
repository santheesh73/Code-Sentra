CREATE TYPE "public"."code_edge_kind" AS ENUM('imports', 'calls', 'defines_route', 'reads_env', 'tests', 'co_changes');--> statement-breakpoint
CREATE TYPE "public"."code_node_kind" AS ENUM('file', 'symbol', 'route', 'api_handler', 'cli_command', 'env_var', 'test');--> statement-breakpoint
CREATE TYPE "public"."feature_status" AS ENUM('complete', 'partial', 'planned');--> statement-breakpoint
CREATE TYPE "public"."snapshot_kind" AS ENUM('git', 'zip');--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"section" text NOT NULL,
	"text" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"verified" boolean NOT NULL,
	"drop_reason" text,
	"drop_detail" text,
	CONSTRAINT "claims_dropped_has_reason" CHECK ("claims"."verified" OR "claims"."drop_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "code_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"kind" "code_edge_kind" NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" "code_node_kind" NOT NULL,
	"path" text,
	"name" text NOT NULL,
	"line" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "code_nodes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "code_nodes_snapshot_key_key" UNIQUE("snapshot_id","key")
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "feature_status" NOT NULL,
	"reason" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sections" jsonb NOT NULL,
	"health_score" integer,
	"health_breakdown" jsonb NOT NULL,
	"claims_total" integer NOT NULL,
	"claims_dropped" integer NOT NULL,
	"coverage" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"model" text,
	"usage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "reports_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "reports_run_key" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "snapshot_kind" NOT NULL,
	"source_url" text,
	"ref" text,
	"commit_sha" text,
	"tree_hash" text,
	"has_history" boolean DEFAULT false NOT NULL,
	"storage_key" text,
	"size_bytes" integer,
	"file_count" integer,
	CONSTRAINT "snapshots_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_report_fk" FOREIGN KEY ("org_id","report_id") REFERENCES "public"."reports"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_snapshot_fk" FOREIGN KEY ("org_id","snapshot_id") REFERENCES "public"."snapshots"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_from_fk" FOREIGN KEY ("org_id","from_id") REFERENCES "public"."code_nodes"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_to_fk" FOREIGN KEY ("org_id","to_id") REFERENCES "public"."code_nodes"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_nodes" ADD CONSTRAINT "code_nodes_snapshot_fk" FOREIGN KEY ("org_id","snapshot_id") REFERENCES "public"."snapshots"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_snapshot_fk" FOREIGN KEY ("org_id","snapshot_id") REFERENCES "public"."snapshots"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claims_report_id_index" ON "claims" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "code_edges_snapshot_id_kind_index" ON "code_edges" USING btree ("snapshot_id","kind");--> statement-breakpoint
CREATE INDEX "features_run_id_index" ON "features" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "snapshots_project_id_tree_hash_index" ON "snapshots" USING btree ("project_id","tree_hash");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_snapshot_fk" FOREIGN KEY ("org_id","snapshot_id") REFERENCES "public"."snapshots"("org_id","id") ON DELETE set null ON UPDATE no action;