import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { pool } from './pool.js';
import { env } from '../config/env.js';
import { baseLogger } from '../lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

/**
 * Forward-only migration runner.
 *
 * Each file runs exactly once, inside its own transaction, and its checksum is
 * recorded. Editing an already-applied migration is rejected rather than
 * silently ignored - that mismatch is the usual cause of "works on my machine,
 * broken in prod" schema drift. A Postgres advisory lock makes concurrent boots
 * (several serverless instances waking at once) safe: one migrates, the rest
 * wait and then find nothing to do.
 */
const LOCK_ID = 4_827_314; // arbitrary, stable for this application

/**
 * Migrations need a direct connection, not a pooled one.
 *
 * `pg_advisory_lock` is session-scoped. Behind a transaction-mode pooler
 * (PgBouncer, which is what Neon's `-pooler` endpoint and most managed
 * Postgres poolers run) a session is not pinned to one backend, so the lock
 * and the unlock can land on different connections - which quietly defeats the
 * mutual exclusion this runner depends on.
 *
 * DIRECT_DATABASE_URL therefore points at the unpooled endpoint. When it is
 * unset - local Docker, where there is no pooler - the ordinary pool is fine.
 */
async function connect(): Promise<{ client: pg.PoolClient | pg.Client; release: () => void }> {
  if (!env.DIRECT_DATABASE_URL) {
    const client = await pool.connect();
    return { client, release: () => client.release() };
  }

  const client = new pg.Client({ connectionString: env.DIRECT_DATABASE_URL });
  await client.connect();
  return { client, release: () => void client.end() };
}

export async function migrate(): Promise<{ applied: string[]; skipped: number }> {
  const { client, release } = await connect();
  const applied: string[] = [];
  let skipped = 0;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER NOT NULL DEFAULT 0
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const name of files) {
      const sql = readFileSync(join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = seen.get(name);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${name} changed after it was applied (recorded ${previous}, now ${checksum}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped++;
        continue;
      }

      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
          [name, checksum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${name} failed: ${(e as Error).message}`);
      }
      applied.push(name);
      baseLogger.info({ migration: name, ms: Date.now() - started }, 'migration applied');
    }

    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    release();
  }
}

// Allow `npm run migrate` to execute this module directly, while leaving it
// importable by the server boot path without re-running as a CLI.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  migrate()
    .then(({ applied, skipped }) => {
      baseLogger.info(
        { applied: applied.length, skipped },
        applied.length ? `applied ${applied.length} migration(s)` : 'schema already up to date',
      );
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      baseLogger.error({ err: e.message }, 'migration failed');
      process.exit(1);
    });
}
