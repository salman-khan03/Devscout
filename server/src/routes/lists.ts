import { Router } from 'express';
import { handler, notFound, conflict, badRequest } from '../lib/errors.js';
import { asTenant, tquery } from '../db/pool.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { entitlement } from '../lib/plans.js';
import { assertCapacity } from '../lib/usage.js';
import { validate, z, uuid } from '../lib/validate.js';
import { audit, track } from '../services/audit.js';

export const lists = Router();

lists.use(requireAuth, requireOrg);

const STAGES = ['sourced', 'contacted', 'screening', 'interview', 'offer', 'hired', 'rejected'] as const;

/**
 * Pipelines: lists of candidates that move through stages.
 *
 * Every statement runs inside asTenant, so the connection is pinned to the
 * caller's org and row-level security applies. The explicit `org_id = $1`
 * predicates are belt and braces - either alone would be sufficient, and
 * keeping both means a mistake in one is caught by the other.
 */

lists.get(
  '/',
  requirePermission('list:read'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `SELECT l.id, l.name, l.description, l.color, l.is_default, l.created_at,
              count(lm.id)::int AS member_count,
              json_object_agg(COALESCE(lm.stage, 'none'), 1) FILTER (WHERE lm.id IS NOT NULL) AS _stages
         FROM lists l
         LEFT JOIN list_members lm ON lm.list_id = l.id
        WHERE l.org_id = $1
        GROUP BY l.id
        ORDER BY l.is_default DESC, l.created_at`,
      [req.org!.id],
      'lists.index',
    );

    // Per-stage counts, so the board renders column headers without N queries.
    const { rows: stageRows } = await tquery(
      req.org!.id,
      `SELECT list_id, stage, count(*)::int AS n
         FROM list_members WHERE org_id = $1 GROUP BY list_id, stage`,
      [req.org!.id],
      'lists.stage_counts',
    );

    const byList = new Map<string, Record<string, number>>();
    for (const r of stageRows) {
      const entry = byList.get(r.list_id) ?? {};
      entry[r.stage] = r.n;
      byList.set(r.list_id, entry);
    }

    res.json(
      rows.map(({ _stages, ...l }) => ({
        ...l,
        stages: byList.get(l.id) ?? {},
      })),
    );
  }),
);

lists.post(
  '/',
  requirePermission('list:write'),
  validate(
    z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(500).optional(),
      color: z.string().trim().max(20).optional(),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `INSERT INTO lists (org_id, name, description, color, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, name) DO NOTHING
       RETURNING *`,
      [
        req.org!.id,
        req.body.name,
        req.body.description ?? null,
        req.body.color ?? 'indigo',
        req.user!.id,
      ],
      'lists.create',
    );
    if (!rows.length) throw conflict('You already have a pipeline with that name.');

    await audit(req, 'list.created', { type: 'list', id: rows[0].id }, { name: req.body.name });
    res.status(201).json(rows[0]);
  }),
);

lists.get(
  '/:id',
  requirePermission('list:read'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const data = await asTenant(req.org!.id, async (db) => {
      const { rows: l } = await db.query(
        `SELECT * FROM lists WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.org!.id],
        'lists.get',
      );
      if (!l.length) return null;

      // The candidate rows joined to their corpus profile, in board order.
      const { rows: members } = await db.query(
        `SELECT lm.id, lm.stage, lm.rating, lm.position, lm.source_query,
                lm.match_evidence, lm.added_at,
                u.name AS added_by_name,
                d.id AS developer_id, d.login, d.name, d.avatar_url, d.html_url, d.bio,
                d.location, d.company, d.followers, d.total_stars, d.original_repos,
                d.recent_pushes, d.languages, d.topics, d.seniority, d.role_fit,
                d.summary, d.is_synthetic, d.last_active_at,
                (SELECT json_agg(t.label) FROM tags t
                  WHERE t.org_id = lm.org_id AND t.developer_id = d.id) AS tags,
                (SELECT count(*)::int FROM notes n
                  WHERE n.org_id = lm.org_id AND n.developer_id = d.id) AS note_count
           FROM list_members lm
           JOIN developers d ON d.id = lm.developer_id
           LEFT JOIN users u ON u.id = lm.added_by
          WHERE lm.list_id = $1 AND lm.org_id = $2
          ORDER BY lm.position, lm.added_at DESC`,
        [req.params.id, req.org!.id],
        'lists.members',
      );

      return { list: l[0], members };
    });

    if (!data) throw notFound('No such pipeline.');
    res.json({ ...data.list, members: data.members, stages: STAGES });
  }),
);

lists.patch(
  '/:id',
  requirePermission('list:write'),
  validate(z.object({ id: uuid }), 'params'),
  validate(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      color: z.string().trim().max(20).optional(),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `UPDATE lists
          SET name = COALESCE($3, name),
              description = COALESCE($4, description),
              color = COALESCE($5, color)
        WHERE id = $1 AND org_id = $2
        RETURNING *`,
      [req.params.id, req.org!.id, req.body.name ?? null, req.body.description ?? null, req.body.color ?? null],
      'lists.update',
    );
    if (!rows.length) throw notFound('No such pipeline.');
    res.json(rows[0]);
  }),
);

lists.delete(
  '/:id',
  requirePermission('list:write'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const deleted = await asTenant(req.org!.id, async (db) => {
      const { rows } = await db.query(
        `SELECT is_default FROM lists WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.org!.id],
      );
      if (!rows.length) return 'missing';
      // Deleting the default would leave "save candidate" with no destination.
      if (rows[0].is_default) return 'default';

      await db.query(`DELETE FROM lists WHERE id = $1 AND org_id = $2`, [
        req.params.id,
        req.org!.id,
      ]);
      return 'ok';
    });

    if (deleted === 'missing') throw notFound('No such pipeline.');
    if (deleted === 'default') throw badRequest('The default pipeline cannot be deleted.');

    await audit(req, 'list.deleted', { type: 'list', id: req.params.id });
    res.status(204).end();
  }),
);

/**
 * Save a candidate to a pipeline.
 *
 * The evidence that surfaced them is stored alongside the membership, so six
 * weeks later the team can still see why this person was worth saving. Without
 * it a shortlist degrades into a list of names with no provenance.
 */
lists.post(
  '/:id/members',
  requirePermission('list:write'),
  validate(z.object({ id: uuid }), 'params'),
  validate(
    z.object({
      developerId: uuid,
      stage: z.enum(STAGES).optional(),
      sourceQuery: z.string().max(200).optional(),
      evidence: z.record(z.unknown()).optional(),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    const plan = entitlement(req.org!.plan, req.org!.subscription_status);
    await assertCapacity(req.org!.id, plan, 'savedCandidates');

    // A discriminated outcome rather than a row-or-sentinel union: the three
    // cases are "no such pipeline", "already on it" and "added", and each one
    // maps to a different status code.
    const outcome = await asTenant(req.org!.id, async (db) => {
      const { rows: owns } = await db.query(
        `SELECT 1 FROM lists WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.org!.id],
      );
      if (!owns.length) return { kind: 'missing' as const };

      const { rows } = await db.query(
        `INSERT INTO list_members
           (org_id, list_id, developer_id, stage, source_query, match_evidence, added_by, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 COALESCE((SELECT max(position) + 1 FROM list_members WHERE list_id = $2), 0))
         ON CONFLICT (list_id, developer_id) DO NOTHING
         RETURNING *`,
        [
          req.org!.id,
          req.params.id,
          req.body.developerId,
          req.body.stage ?? 'sourced',
          req.body.sourceQuery ?? null,
          JSON.stringify(req.body.evidence ?? {}),
          req.user!.id,
        ],
        'lists.add_member',
      );
      // ON CONFLICT DO NOTHING returns no row when the candidate is already
      // on the pipeline.
      return rows[0]
        ? { kind: 'created' as const, row: rows[0] }
        : { kind: 'duplicate' as const };
    });

    if (outcome.kind === 'missing') throw notFound('No such pipeline.');
    if (outcome.kind === 'duplicate') {
      throw conflict('That candidate is already on this pipeline.');
    }

    void track(req, 'shortlisted', req.body.developerId, {
      listId: req.params.id,
      query: req.body.sourceQuery,
    });
    res.status(201).json(outcome.row);
  }),
);

/** Move a candidate between stages, rate them, or reorder the board. */
lists.patch(
  '/:id/members/:memberId',
  requirePermission('list:write'),
  validate(z.object({ id: uuid, memberId: uuid }), 'params'),
  validate(
    z.object({
      stage: z.enum(STAGES).optional(),
      rating: z.number().int().min(1).max(5).nullable().optional(),
      position: z.number().int().min(0).optional(),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `UPDATE list_members
          SET stage = COALESCE($4, stage),
              rating = CASE WHEN $5::boolean THEN $6 ELSE rating END,
              position = COALESCE($7, position)
        WHERE id = $1 AND list_id = $2 AND org_id = $3
        RETURNING *`,
      [
        req.params.memberId,
        req.params.id,
        req.org!.id,
        req.body.stage ?? null,
        'rating' in req.body,
        req.body.rating ?? null,
        req.body.position ?? null,
      ],
      'lists.update_member',
    );
    if (!rows.length) throw notFound('That candidate is not on this pipeline.');

    if (req.body.stage) {
      void track(req, 'staged', rows[0].developer_id, { stage: req.body.stage });
    }
    res.json(rows[0]);
  }),
);

lists.delete(
  '/:id/members/:memberId',
  requirePermission('list:write'),
  validate(z.object({ id: uuid, memberId: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `DELETE FROM list_members
        WHERE id = $1 AND list_id = $2 AND org_id = $3
        RETURNING developer_id`,
      [req.params.memberId, req.params.id, req.org!.id],
      'lists.remove_member',
    );
    if (!rows.length) throw notFound('That candidate is not on this pipeline.');

    void track(req, 'unshortlisted', rows[0].developer_id, { listId: req.params.id });
    res.status(204).end();
  }),
);

/* -------------------------------------------------------------------------
 * Notes and tags. Attached to the developer within an org, not to a list -
 * a candidate on two pipelines carries the same team knowledge on both.
 * ---------------------------------------------------------------------- */

lists.post(
  '/notes/:developerId',
  requirePermission('note:write'),
  validate(z.object({ developerId: uuid }), 'params'),
  validate(z.object({ body: z.string().trim().min(1).max(5000) })),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `INSERT INTO notes (org_id, developer_id, author_id, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.org!.id, req.params.developerId, req.user!.id, req.body.body],
      'notes.create',
    );
    void track(req, 'noted', req.params.developerId);
    res.status(201).json({ ...rows[0], author_name: req.user!.name });
  }),
);

lists.patch(
  '/notes/:noteId',
  requirePermission('note:write'),
  validate(z.object({ noteId: uuid }), 'params'),
  validate(z.object({ body: z.string().trim().min(1).max(5000) })),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `UPDATE notes SET body = $3 WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.noteId, req.org!.id, req.body.body],
      'notes.update',
    );
    if (!rows.length) throw notFound('No such note.');
    res.json(rows[0]);
  }),
);

lists.delete(
  '/notes/:noteId',
  requirePermission('note:write'),
  validate(z.object({ noteId: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rowCount } = await tquery(
      req.org!.id,
      `DELETE FROM notes WHERE id = $1 AND org_id = $2`,
      [req.params.noteId, req.org!.id],
      'notes.delete',
    );
    if (!rowCount) throw notFound('No such note.');
    res.status(204).end();
  }),
);

lists.post(
  '/tags/:developerId',
  requirePermission('tag:write'),
  validate(z.object({ developerId: uuid }), 'params'),
  validate(z.object({ label: z.string().trim().min(1).max(40) })),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `INSERT INTO tags (org_id, developer_id, label, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, developer_id, label) DO UPDATE SET label = EXCLUDED.label
       RETURNING *`,
      [req.org!.id, req.params.developerId, req.body.label, req.user!.id],
      'tags.create',
    );
    void track(req, 'tagged', req.params.developerId, { label: req.body.label });
    res.status(201).json(rows[0]);
  }),
);

lists.delete(
  '/tags/:tagId',
  requirePermission('tag:write'),
  validate(z.object({ tagId: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rowCount } = await tquery(
      req.org!.id,
      `DELETE FROM tags WHERE id = $1 AND org_id = $2`,
      [req.params.tagId, req.org!.id],
      'tags.delete',
    );
    if (!rowCount) throw notFound('No such tag.');
    res.status(204).end();
  }),
);

/** Every tag in the workspace, with counts, for the filter sidebar. */
lists.get(
  '/tags/all',
  requirePermission('list:read'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await tquery(
      req.org!.id,
      `SELECT label, count(*)::int AS count FROM tags
        WHERE org_id = $1 GROUP BY label ORDER BY count DESC, label LIMIT 100`,
      [req.org!.id],
      'tags.index',
    );
    res.json(rows);
  }),
);
