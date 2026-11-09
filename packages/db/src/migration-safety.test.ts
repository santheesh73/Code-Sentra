import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "./migrate.js";
import { TEST_POSTGRES_IMAGE } from "./testing.js";

// Migration-safety gate (Section 20). Proves the migrations apply cleanly to an EMPTY
// Postgres 16, are idempotent (safe to re-run on every deploy), leave RLS enabled on the
// tenant tables, and contain no data-losing DDL that slipped in unreviewed. This runs in the
// standard `test` CI job, so a bad migration cannot merge.

const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Data-losing statements that must never land without explicit, reviewed intent. DROP
// CONSTRAINT / DROP NOT NULL / DROP DEFAULT are schema-only and allowed.
const DESTRUCTIVE = [/\bdrop\s+table\b/i, /\bdrop\s+column\b/i, /\btruncate\b/i];

describe("migration SQL hygiene (no DB)", () => {
  it("contains no unreviewed data-losing DDL", () => {
    const offenders: string[] = [];
    for (const f of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      // Opt-out marker for a deliberate, reviewed destructive change.
      if (/--\s*migration-safety:\s*allow-destructive/i.test(sql)) continue;
      for (const re of DESTRUCTIVE) if (re.test(sql)) offenders.push(`${f}: ${re}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("has at least the known migrations", () => {
    expect(sqlFiles.length).toBeGreaterThanOrEqual(14);
  });
});

describe("migrations against an empty Postgres", () => {
  let container: StartedTestContainer & { getConnectionUri(): string };
  let url: string;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    container = (await new PostgreSqlContainer(TEST_POSTGRES_IMAGE).start()) as never;
    url = container.getConnectionUri();
  }, 180_000);

  afterAll(async () => container?.stop());

  it("applies cleanly to an empty database and is idempotent on a second run", async () => {
    await runMigrations(url); // clean-room apply
    await runMigrations(url); // must be a no-op, never throw

    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // Every SQL file is recorded exactly once.
      const applied = await client.query<{ n: string }>(
        "select count(*)::text as n from drizzle.__drizzle_migrations",
      );
      expect(Number(applied.rows[0]?.n)).toBe(sqlFiles.length);

      // RLS is enabled on the tenant tables that hold customer data.
      const rls = await client.query<{ relname: string }>(
        `select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
      );
      const withRls = new Set(rls.rows.map((r) => r.relname));
      for (const t of ["runs", "evidence", "findings", "issues", "projects"])
        expect(withRls.has(t), `RLS must be enabled on ${t}`).toBe(true);

      // The app role exists and cannot bypass RLS (defence in depth).
      const role = await client.query<{ rolbypassrls: boolean }>(
        "select rolbypassrls from pg_roles where rolname = 'codesentra_app'",
      );
      expect(role.rows[0]?.rolbypassrls).toBe(false);
    } finally {
      await client.end();
    }
  }, 120_000);
});
