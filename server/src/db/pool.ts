import pg from 'pg';
import { env } from '../config/env.js';
import { baseLogger, log } from '../lib/logger.js';
import { dbQueryDuration } from '../lib/metrics.js';

const { Pool, types } = pg;

// node-postgres hands back BIGINT and NUMERIC as strings to avoid silent
// precision loss. Every such column in this schema is a count that fits in a
// double, so parse them into numbers and keep the API free of "42" strings.
types.setTypeParser(20, (v) => parseInt(v, 10)); // int8
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

/** Managed Postgres (Neon, Supabase, RDS) terminates TLS but with its own CA. */
const needsSsl =
  env.isProd || /\bsslmode=require\b/.test(env.DATABASE_URL) || /neon\.tech|supabase\.|render\.com/.test(env.DATABASE_URL);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  // Serverless functions each hold their own pool, so keep it small and let
  // idle sockets close quickly rather than exhausting the server's slots.
  max: env.isProd ? 5 : 10,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'devscout',
});

pool.on('error', (err) => baseLogger.error({ err: err.message }, 'idle postgres client errored'));

/**
 * Unscoped query. PRIVILEGED: it runs with the connecting user's rights, so
 * row-level security does NOT constrain it.
 *
 * That is deliberate and unavoidable - migrations, auth lookups, the shared
 * developer corpus and the ingestion queue are all cross-tenant by nature and
 * could not run under a tenant policy. The consequence is that this function
 * must only ever be pointed at global or infrastructure tables.
 *
 * Anything owned by a tenant - lists, list_members, notes, tags,
 * saved_searches, search_events, activity_events, audit_log, usage_counters -
 * goes through `asTenant`, where RLS applies and a forgotten predicate returns
 * zero rows rather than another customer's data.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  op = 'query',
): Promise<pg.QueryResult<T>> {
  const end = dbQueryDuration.startTimer({ op });
  try {
    return await pool.query<T>(text, params as any[]);
  } finally {
    end();
  }
}

export interface TenantClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
    op?: string,
  ): Promise<pg.QueryResult<T>>;
}

/**
 * Runs `fn` inside a transaction whose connection is pinned to one org.
 *
 * `SET LOCAL app.org_id` feeds the row-level-security policies defined in
 * migration 0005, so tenant tables physically cannot return another org's rows
 * on this connection - even if a query forgets its `WHERE org_id = ...`. The
 * application still writes that predicate everywhere; RLS is the backstop that
 * turns a missing filter into zero rows instead of a data leak.
 *
 * SET LOCAL is scoped to the transaction, so the setting cannot leak to the
 * next borrower of this pooled connection.
 */
export async function asTenant<T>(orgId: string, fn: (db: TenantClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parameterised through set_config rather than interpolated into SET.
    await client.query('SELECT set_config($1, $2, true)', ['app.org_id', orgId]);
    // Drop to the least-privilege role for the rest of this transaction.
    // Superusers - which is what local Docker and several managed providers
    // hand you - bypass RLS no matter what the policies say, so without this
    // the isolation in migration 0005 would not actually be enforced.
    // SET LOCAL reverts at COMMIT/ROLLBACK, so the pooled connection is clean
    // for its next borrower.
    await client.query('SET LOCAL ROLE devscout_app');

    const db: TenantClient = {
      async query(text, params = [], op = 'tenant') {
        const end = dbQueryDuration.startTimer({ op });
        try {
          return await client.query(text, params as any[]);
        } finally {
          end();
        }
      },
    };

    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Convenience for the common single-statement tenant read. */
export function tquery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  orgId: string,
  text: string,
  params: unknown[] = [],
  op = 'tenant',
) {
  return asTenant(orgId, (db) => db.query<T>(text, params, op));
}

/** Plain transaction with no tenant pinning (registration, billing webhooks). */
export async function transaction<T>(fn: (db: TenantClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (text, params = []) => client.query(text, params as any[]),
    });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function healthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    log().error({ err: (e as Error).message }, 'postgres health check failed');
    return false;
  }
}

/** pgvector's text input format. A JS array would be sent as a Postgres array. */
export const toVector = (v: number[]) => `[${v.map((n) => n.toFixed(6)).join(',')}]`;
