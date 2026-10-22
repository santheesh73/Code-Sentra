-- RLS for the Phase 5 tenant tables (same pattern as 0001_rls, ADR 0009).
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON schedules
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON schedules TO codesentra_app;
--> statement-breakpoint
ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_channels
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_channels TO codesentra_app;
--> statement-breakpoint
-- Bearer authentication looks tokens up by hash as the system role (like sessions);
-- listing and revoking happen inside the org.
ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_tokens
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON api_tokens TO codesentra_app;
