import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";

export const TEST_POSTGRES_IMAGE = "postgres:16.15-alpine";

export interface TestDatabase {
  url: string;
  db: Database;
  stop(): Promise<void>;
}

/**
 * A freshly migrated database for one test file.
 * - TEST_DATABASE_URL set: creates a throwaway database on that server (fast, no Docker).
 * - Otherwise: starts a Testcontainers Postgres 16.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (adminUrl) {
    const name = `cs_test_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    const url = u.toString();
    await runMigrations(url);
    const db = createDatabase(url, { max: 5 });
    return {
      url,
      db,
      async stop() {
        await db.close();
        const c = new pg.Client({ connectionString: adminUrl });
        await c.connect();
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await c.end();
      },
    };
  }
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const db = createDatabase(url, { max: 5 });
  return {
    url,
    db,
    async stop() {
      await db.close();
      await container.stop();
    },
  };
}
