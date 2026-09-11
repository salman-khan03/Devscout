import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, asTenant, transaction } from '../src/db/pool.js';
import { verifyTenantIsolation } from '../src/db/verify.js';
import { hashPassword } from '../src/lib/auth.js';
import { prepareSchema, uniq } from './setup.js';

/**
 * Tenant isolation.
 *
 * This is the test that matters most in a multi-tenant product: every other
 * bug produces a wrong answer, this one produces someone else's data. It is
 * checked at both levels, because they fail independently - the API can be
 * correct while the database is wide open to any query that forgets its
 * predicate, and vice versa.
 */

const app = createApp();

interface Tenant {
  orgId: string;
  listId: string;
  email: string;
  password: string;
  cookie: string;
}

async function createTenant(label: string): Promise<Tenant> {
  const email = `${uniq(label)}@example.test`;
  const password = 'isolation-test-password';

  const { orgId, listId } = await transaction(async (db) => {
    const { rows: u } = await db.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`,
      [email, await hashPassword(password), label],
    );
    const { rows: o } = await db.query(
      `INSERT INTO orgs (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [label, uniq(label), u[0].id],
    );
    await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [
      o[0].id,
      u[0].id,
    ]);
    const { rows: l } = await db.query(
      `INSERT INTO lists (org_id, name, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [o[0].id, `${label} pipeline`, u[0].id],
    );
    return { orgId: o[0].id as string, listId: l[0].id as string };
  });

  const res = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).join('; ');

  return { orgId, listId, email, password, cookie };
}

let acme: Tenant;
let globex: Tenant;

beforeAll(async () => {
  await prepareSchema();
  acme = await createTenant('acme');
  globex = await createTenant('globex');
}, 60_000);

describe('database-level isolation', () => {
  it('enforces row-level security rather than relying on query predicates', async () => {
    const report = await verifyTenantIsolation();
    expect(report.detail).toBeTruthy();
    // If this fails the whole tenancy story is decorative - see migration 0007.
    expect(report.enforced).toBe(true);
  });

  it('hides another tenant rows even from a query with NO org predicate', async () => {
    // Deliberately omits `WHERE org_id = ...`. Only RLS can be preventing a
    // leak here, which is precisely what is being asserted.
    const seen = await asTenant(acme.orgId, (db) =>
      db.query(`SELECT id FROM lists`),
    );
    const ids = seen.rows.map((r) => r.id);

    expect(ids).toContain(acme.listId);
    expect(ids).not.toContain(globex.listId);
  });

  it('fails closed inside a tenant transaction that sets no org', async () => {
    // asTenant always sets app.org_id, so this drives the same restricted role
    // with a context that matches nothing. The policy compares against NULL,
    // which RLS treats as deny.
    const nobody = '00000000-0000-0000-0000-000000000000';
    const { rows } = await asTenant(nobody, (db) => db.query(`SELECT id FROM lists`));
    expect(rows).toHaveLength(0);
  });

  /**
   * Pins down the exact boundary of the guarantee, because overstating it
   * would be worse than not having it.
   *
   * RLS constrains the RESTRICTED role that asTenant switches into. The
   * unscoped pool deliberately keeps the connecting user's privileges - it has
   * to, because migrations, auth lookups, the shared developer corpus and the
   * ingestion queue are all cross-tenant by nature and could not function
   * under a tenant policy.
   *
   * So the accurate claim is: every tenant-scoped read and write goes through
   * asTenant, and inside asTenant a missing org predicate returns zero rows
   * instead of another customer's data. The unscoped pool is privileged by
   * design and is only ever pointed at global or infrastructure tables.
   */
  it('documents that the unscoped pool is privileged by design', async () => {
    const { rows } = await query(`SELECT id FROM lists WHERE id = $1`, [acme.listId]);
    expect(rows).toHaveLength(1);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    // The WITH CHECK half of the policy: a tenant cannot insert rows stamped
    // with someone else's org id.
    await expect(
      asTenant(acme.orgId, (db) =>
        db.query(`INSERT INTO lists (org_id, name) VALUES ($1, 'smuggled')`, [globex.orgId]),
      ),
    ).rejects.toThrow();
  });
});

describe('API-level isolation', () => {
  it('lists only the caller own pipelines', async () => {
    const res = await request(app).get('/api/lists').set('Cookie', acme.cookie).expect(200);
    const ids = res.body.map((l: { id: string }) => l.id);
    expect(ids).toContain(acme.listId);
    expect(ids).not.toContain(globex.listId);
  });

  it('404s when fetching another tenant pipeline by its real id', async () => {
    // 404 rather than 403: confirming the id exists would itself leak.
    await request(app)
      .get(`/api/lists/${globex.listId}`)
      .set('Cookie', acme.cookie)
      .expect(404);
  });

  it('403s when the org header names a workspace the caller is not in', async () => {
    await request(app)
      .get('/api/lists')
      .set('Cookie', acme.cookie)
      .set('x-devscout-org', globex.orgId)
      .expect(403);
  });

  it('refuses to add a candidate to another tenant pipeline', async () => {
    const { rows } = await query(`SELECT id FROM developers LIMIT 1`);
    if (!rows.length) return; // corpus not seeded in this environment

    await request(app)
      .post(`/api/lists/${globex.listId}/members`)
      .set('Cookie', acme.cookie)
      .send({ developerId: rows[0].id })
      .expect(404);
  });

  it('rejects requests with no session at all', async () => {
    await request(app).get('/api/lists').expect(401);
  });
});
