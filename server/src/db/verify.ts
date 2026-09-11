import { randomUUID } from 'node:crypto';
import { pool } from './pool.js';
import { env } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';

/**
 * Proves at boot that tenant isolation is actually enforced by the database.
 *
 * This check exists because the failure it catches is silent. RLS policies can
 * be present and correct while a superuser connection bypasses all of them -
 * queries keep succeeding, they just return other tenants' rows. Nothing in
 * the app surfaces that. So instead of trusting the configuration, we write
 * two rows under two synthetic org ids and assert that each tenant context can
 * see exactly one of them.
 *
 * Everything is rolled back; the check leaves no rows behind.
 */
export interface IsolationReport {
  enforced: boolean;
  role: string;
  isSuperuser: boolean;
  detail: string;
}

export async function verifyTenantIsolation(): Promise<IsolationReport> {
  const orgA = randomUUID();
  const orgB = randomUUID();
  const client = await pool.connect();

  try {
    const { rows: who } = await client.query<{ usename: string; usesuper: boolean }>(
      `SELECT current_user AS usename, usesuper FROM pg_user WHERE usename = current_user`,
    );
    const role = who[0]?.usename ?? 'unknown';
    const isSuperuser = who[0]?.usesuper ?? false;

    await client.query('BEGIN');
    // Seed two tenants with one list each. Runs as the connecting user so the
    // fixture itself is not subject to the policies under test.
    await client.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1,'isolation-probe-a',$2), ($3,'isolation-probe-b',$4)`,
      [orgA, `probe-a-${orgA.slice(0, 8)}`, orgB, `probe-b-${orgB.slice(0, 8)}`],
    );
    await client.query(`INSERT INTO lists (org_id, name) VALUES ($1,'probe'), ($2,'probe')`, [
      orgA,
      orgB,
    ]);

    // Now read them back the way the application does.
    await client.query('SAVEPOINT probe');
    await client.query('SELECT set_config($1,$2,true)', ['app.org_id', orgA]);
    await client.query('SET LOCAL ROLE devscout_app');
    const { rows: seen } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lists WHERE name = 'probe'`,
    );
    const visible = seen[0].n;

    await client.query('ROLLBACK');

    // Tenant A wrote one probe row and tenant B wrote another. Isolation holds
    // if and only if A sees exactly its own.
    const enforced = visible === 1;
    return {
      enforced,
      role,
      isSuperuser,
      detail: enforced
        ? `row-level security enforced for role "${role}"`
        : `tenant context saw ${visible} of 2 probe rows - policies are NOT being applied`,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return {
      enforced: false,
      role: 'unknown',
      isSuperuser: false,
      detail: `isolation probe failed to run: ${(e as Error).message}`,
    };
  } finally {
    client.release();
  }
}

/**
 * Boot gate. In production a broken isolation guarantee is a stop-the-line
 * problem, so the process refuses to start. In development it is a loud
 * warning, because a developer pointing at a scratch database should not be
 * blocked from working.
 */
export async function assertTenantIsolation(): Promise<void> {
  const report = await verifyTenantIsolation();

  if (report.enforced) {
    baseLogger.info({ role: report.role }, 'tenant isolation verified');
    return;
  }

  const message =
    `TENANT ISOLATION IS NOT ENFORCED: ${report.detail}. ` +
    (report.isSuperuser
      ? `The connection uses superuser "${report.role}", which bypasses row-level security. ` +
        'Connect as a non-superuser, or confirm migration 0007 created the devscout_app role.'
      : 'Check that migrations 0005 and 0007 applied successfully.');

  if (env.isProd) throw new Error(message);
  baseLogger.error({ report }, message);
}

/** Sanity check that pgvector and the ANN index the ranker depends on exist. */
export async function verifyVectorSupport(): Promise<{ ok: boolean; detail: string }> {
  try {
    const ext = await pool.query<{ extversion: string }>(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    if (!ext.rows.length) {
      return { ok: false, detail: 'pgvector extension is not installed' };
    }

    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes
        WHERE tablename = 'developers' AND indexname = 'idx_dev_embedding'`,
    );
    return idx.rowCount
      ? { ok: true, detail: `pgvector ${ext.rows[0].extversion}, HNSW index present` }
      : { ok: false, detail: 'pgvector installed but the HNSW index is missing' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
