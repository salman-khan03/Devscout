import { afterAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { store } from '../src/lib/redis.js';
import { migrate } from '../src/db/migrate.js';

/**
 * Test harness.
 *
 * The suite runs against a real Postgres, not a mock. Most of what is worth
 * testing here - row-level security, SKIP LOCKED claims, JSONB containment,
 * the fusion SQL - is behaviour of the database itself, and a mock would
 * happily confirm assumptions that production does not hold. The RLS bug that
 * a superuser silently bypasses every policy is exactly the class of thing a
 * mocked test would have missed.
 */
export async function prepareSchema(): Promise<void> {
  await migrate();
}

/** Unique per test file so parallel files cannot collide on a slug or email. */
export const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

afterAll(async () => {
  await pool.end().catch(() => undefined);
  await store.close().catch(() => undefined);
});
