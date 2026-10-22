import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

declare const tenantBrand: unique symbol;
/**
 * A transaction scoped to one organization: app.org_id is set and the role is
 * codesentra_app, so RLS filters every statement. Tenant queries take this type, so
 * passing the unscoped system handle is a type error.
 */
export type TenantTx = Transaction & { readonly [tenantBrand]: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Database {
  /**
   * Unscoped access as the connection role (RLS bypassed). Only for work that is
   * inherently cross-tenant: authentication, membership lookup, job bookkeeping.
   */
  system: Db;
  pool: pg.Pool;
  withOrg<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
}

export function createDatabase(connectionString: string, opts: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "codesentra",
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  const system = drizzle(pool, { schema });

  return {
    system,
    pool,
    async withOrg(orgId, fn) {
      if (!UUID.test(orgId)) throw new TypeError("withOrg: orgId must be a UUID");
      return system.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
        await tx.execute(sql`set local role codesentra_app`);
        return fn(tx as TenantTx);
      });
    },
    async close() {
      await pool.end();
    },
  };
}
