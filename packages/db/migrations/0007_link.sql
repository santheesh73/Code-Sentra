CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"finding_id" uuid,
	"code_node_id" uuid,
	"run_id" uuid NOT NULL,
	"join_key" text NOT NULL,
	"verified" boolean NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"symbol" text,
	"excerpt" text,
	"env_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "traces_verified" CHECK ("traces"."verified")
);
--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_code_node_id_code_nodes_id_fk" FOREIGN KEY ("code_node_id") REFERENCES "public"."code_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_issue_fk" FOREIGN KEY ("org_id","issue_id") REFERENCES "public"."issues"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "traces_issue_id_index" ON "traces" USING btree ("issue_id");