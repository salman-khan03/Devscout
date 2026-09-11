import { Router } from 'express';
import { handler, notFound, conflict } from '../lib/errors.js';
import { tquery } from '../db/pool.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { entitlement } from '../lib/plans.js';
import { assertCapacity } from '../lib/usage.js';
import { validate, z, uuid } from '../lib/validate.js';

export const savedSearches = Router();

savedSearches.use(requireAuth, requireOrg);

/**
 * Saved searches store the whole filter object, not just the query text, so
 * restoring one reproduces the exact result set - including the ranking mode.
 * The web app turns the same object into a URL, which means a saved search and
 * a pasted link are the same thing and stay in sync by construction.
 */
const filtersShape = z
  .object({
    q: z.string().max(200).optional(),
    languages: z.array(z.string()).max(20).optional(),
    topics: z.array(z.string()).max(20).optional(),
    locations: z.array(z.string()).max(10).optional(),
    seniority: z.array(z.string()).max(4).optional(),
    minFollowers: z.number().int().min(0).optional(),
    minStars: z.number().int().min(0).optional(),
    minRepos: z.number().int().min(0).optional(),
    activeWithinDays: z.number().int().min(1).optional(),
    hireable: z.boolean().optional(),
    excludeSaved: z.boolean().optional(),
    savedOnly: z.boolean().optional(),
    mode: z.enum(['hybrid', 'vector', 'lexical', 'signal']).optional(),
    sort: z.enum(['relevance', 'stars', 'followers', 'recent']).optional(),
  })
  .strip();

savedSearches.get(
  '/',
  requirePermission('savedSearch:read'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `SELECT s.id, s.name, s.query, s.filters, s.is_shared, s.run_count,
              s.last_run_at, s.created_at, u.name AS created_by_name
         FROM saved_searches s
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.org_id = $1 AND (s.is_shared OR s.created_by = $2)
        ORDER BY s.last_run_at DESC NULLS LAST, s.created_at DESC`,
      [req.org!.id, req.user!.id],
      'saved_searches.index',
    );
    res.json(rows);
  }),
);

savedSearches.post(
  '/',
  requirePermission('savedSearch:write'),
  validate(
    z.object({
      name: z.string().trim().min(1).max(80),
      query: z.string().trim().max(200).default(''),
      filters: filtersShape.default({}),
      isShared: z.boolean().default(true),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    const plan = entitlement(req.org!.plan, req.org!.subscription_status);
    await assertCapacity(req.org!.id, plan, 'savedSearches');

    const { rows } = await tquery(
      req.org!.id,
      `INSERT INTO saved_searches (org_id, name, query, filters, is_shared, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, name) DO NOTHING
       RETURNING *`,
      [
        req.org!.id,
        req.body.name,
        req.body.query,
        JSON.stringify(req.body.filters),
        req.body.isShared,
        req.user!.id,
      ],
      'saved_searches.create',
    );
    if (!rows.length) throw conflict('A saved search with that name already exists.');
    res.status(201).json(rows[0]);
  }),
);

savedSearches.patch(
  '/:id',
  requirePermission('savedSearch:write'),
  validate(z.object({ id: uuid }), 'params'),
  validate(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      query: z.string().trim().max(200).optional(),
      filters: filtersShape.optional(),
      isShared: z.boolean().optional(),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `UPDATE saved_searches
          SET name = COALESCE($3, name),
              query = COALESCE($4, query),
              filters = COALESCE($5::jsonb, filters),
              is_shared = COALESCE($6, is_shared)
        WHERE id = $1 AND org_id = $2
        RETURNING *`,
      [
        req.params.id,
        req.org!.id,
        req.body.name ?? null,
        req.body.query ?? null,
        req.body.filters ? JSON.stringify(req.body.filters) : null,
        req.body.isShared ?? null,
      ],
      'saved_searches.update',
    );
    if (!rows.length) throw notFound('No such saved search.');
    res.json(rows[0]);
  }),
);

/** Records a run, so the list can be ordered by what the team actually uses. */
savedSearches.post(
  '/:id/run',
  requirePermission('savedSearch:read'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `UPDATE saved_searches
          SET run_count = run_count + 1, last_run_at = now()
        WHERE id = $1 AND org_id = $2
        RETURNING id, name, query, filters, is_shared, run_count, last_run_at, created_at`,
      [req.params.id, req.org!.id],
      'saved_searches.run',
    );
    if (!rows.length) throw notFound('No such saved search.');
    res.json(rows[0]);
  }),
);

savedSearches.delete(
  '/:id',
  requirePermission('savedSearch:write'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rowCount } = await tquery(
      req.org!.id,
      `DELETE FROM saved_searches WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.org!.id],
      'saved_searches.delete',
    );
    if (!rowCount) throw notFound('No such saved search.');
    res.status(204).end();
  }),
);
