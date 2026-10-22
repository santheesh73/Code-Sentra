-- RLS for Phase 5 GitHub tables (same pattern as 0001_rls, ADR 0009).
ALTER TABLE github_check_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON github_check_runs
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON github_check_runs TO codesentra_app;
--> statement-breakpoint
-- Installations: an org reads only the ones linked to it; linking and webhook upkeep run
-- as the system role (the webhook has no tenant), so the app role cannot write them.
ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON github_installations FOR SELECT USING (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT ON github_installations TO codesentra_app;
--> statement-breakpoint
-- Webhook deliveries are system-only: no grant to the app role at all.
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
