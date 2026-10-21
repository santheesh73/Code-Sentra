-- Row-level security for tenant tables (ADR 0009).
--
-- Tenant code runs inside withOrg(): a transaction that sets app.org_id and does
-- SET LOCAL ROLE codesentra_app. That role has no BYPASSRLS, so every query it runs
-- is filtered by these policies even if the code forgets a WHERE org_id = ... clause.
-- The connection's own role (the table owner) is used only for explicit system work
-- (auth, job claiming, migrations).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'codesentra_app') THEN
    CREATE ROLE codesentra_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT codesentra_app TO CURRENT_USER;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO codesentra_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org() TO codesentra_app;
--> statement-breakpoint

-- organizations: the current org only; tenant code cannot create or delete orgs.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations
  USING (id = app_current_org()) WITH CHECK (id = app_current_org());
--> statement-breakpoint
GRANT SELECT, UPDATE ON organizations TO codesentra_app;
--> statement-breakpoint

-- users: only members of the current org, and only non-sensitive columns.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY members_of_current_org ON users
  USING (EXISTS (
    SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = app_current_org()
  ));
--> statement-breakpoint
GRANT SELECT (id, email, name, avatar_url) ON users TO codesentra_app;
--> statement-breakpoint

-- Tables with org_id.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON projects
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON environments
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON runs
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON run_steps
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_log
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, projects, environments, runs, run_steps TO codesentra_app;
--> statement-breakpoint
-- The audit log is append-only for tenant code.
GRANT SELECT, INSERT ON audit_log TO codesentra_app;
