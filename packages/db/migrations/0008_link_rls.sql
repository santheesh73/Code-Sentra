-- RLS for Phase 4 Link tables (same pattern as 0001_rls, ADR 0009).
ALTER TABLE traces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON traces
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON traces TO codesentra_app;
