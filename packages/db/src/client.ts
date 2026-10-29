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
  /**
   * An idle pooled connection failed (Postgres restarted, failed over or ended it). The
   * pool has already dropped it and opens a new one on demand. Default: a warning.
   */
  onError?: (e: Error) => void;
}

export function createDatabase(connectionString: string, opts: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "codesentra",
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // Without a listener, an idle connection's error is an unhandled 'error' event, which
  // ends the process.
  pool.on(
    "error",
    opts.onError ?? ((e) => process.emitWarning(`database connection error: ${e.message}`)),
  );
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
      // pool.end() resolves once no client is idle or checked out, before each connection has
      // finished closing. Wait for those too (each emits "remove"), so whatever stops
      // Postgres next does not race them; never more than 5 s.
      let open = pool.totalCount;
      const closed = new Promise<void>((resolve) => {
        if (open === 0) resolve();
        pool.on("remove", () => {
          if (--open <= 0) resolve();
        });
      });
      await pool.end();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000).unref())]);
    },
  };
}
