# 0009 — Tenant isolation with Postgres RLS and `withOrg`

- **Status:** accepted (Phase 1)

## Decision

- Every tenant-owned table has `org_id`. Child tables reference parents through
  **composite foreign keys** `(org_id, parent_id) → parent(org_id, id)`, so a row can never
  point into another org, even through the system connection.
- Migration `0001_rls` creates role `codesentra_app` (NOLOGIN, no BYPASSRLS), enables RLS
  on tenant tables, and adds `org_id = app_current_org()` policies (`USING` and `WITH CHECK`).
  `app_current_org()` reads the transaction setting `app.org_id`.
- `db.withOrg(orgId, fn)` opens a transaction, runs `set_config('app.org_id', $1, true)`
  and `SET LOCAL ROLE codesentra_app`, then hands `fn` a branded `TenantTx`. Tenant query
  helpers accept only `TenantTx`.
- `codesentra_app` gets no grants on `sessions`, `magic_link_tokens` or `auth_identities`.
  It sees only the `id, email, name, avatar_url` columns of `users`, and only for members
  of the current org. The audit log is insert/select only.
- `db.system` (the connection role, which owns the tables and bypasses RLS) is reserved
  for inherently cross-tenant work: authentication, membership lookup, resolving which
  org a project or run belongs to, and job bookkeeping.
- The API authorizes first (membership and role, with 404 for non-members so existence
  never leaks), then does tenant reads and writes through `withOrg`. RLS is the second line
  of defence.

## Known limitation

Raw SQL inside a tenant transaction can run `RESET ROLE` or `set_config('app.org_id', …)`
and leave the scope (`db.test.ts` documents this). Tenant code never builds SQL from
request input, and query helpers use Drizzle's parameterised builder. Making escape
impossible needs a separate login role for tenant connections (a second credential).
Revisit if raw SQL ever becomes necessary in tenant paths.

## Tests

`packages/db/src/db.test.ts` attacks RLS directly. `apps/api/src/__tests__/cross-org.test.ts`
attacks every registered route with another org's ids, expects 404, and checks the victim's
data is unchanged. It fails if a new route is not classified.
