import { Router } from 'express';
import { handler, notFound, badRequest } from '../lib/errors.js';
import { query } from '../db/pool.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { meter } from '../lib/usage.js';
import { rateLimit } from '../lib/ratelimit.js';
import { validate, z, uuid, githubLogin, intParam } from '../lib/validate.js';
import { enqueue, stats } from '../lib/queue.js';
import { audit } from '../services/audit.js';
import { githubConfigured, rateLimitStatus } from '../services/github.js';
import { activeModel } from '../services/embeddings.js';

export const ingest = Router();

ingest.use(requireAuth, requireOrg);

/**
 * Ingestion control plane: enqueue work, watch it progress, see how much
 * GitHub quota is left. The jobs themselves run in the worker (or the cron
 * drain on serverless) - nothing here does GitHub I/O on the request path.
 */

ingest.post(
  '/profile',
  requirePermission('ingest:enqueue'),
  rateLimit({ name: 'ingest', windowSeconds: 60, max: 60, by: 'org' }),
  meter('ingest_jobs'),
  validate(z.object({ login: githubLogin })),
  handler(async (req: AuthedRequest, res) => {
    const { job, deduped } = await enqueue({
      kind: 'profile',
      target: req.body.login,
      orgId: req.org!.id,
      requestedBy: req.user!.id,
      priority: 3,
    });
    await audit(req, 'ingest.enqueued', { type: 'job', id: job.id }, { login: req.body.login });
    res.status(deduped ? 200 : 202).json({ job, deduped });
  }),
);

/**
 * Bulk discovery: hand it a GitHub search query and it fans out one profile
 * job per result. `language:rust location:berlin followers:>100` works, because
 * the query string is passed to GitHub's own search syntax unchanged.
 */
ingest.post(
  '/discover',
  requirePermission('ingest:enqueue'),
  rateLimit({ name: 'discover', windowSeconds: 300, max: 10, by: 'org' }),
  meter('ingest_jobs'),
  validate(
    z.object({
      query: z.string().trim().min(2).max(200),
      perPage: z.number().int().min(1).max(100).default(30),
    }),
  ),
  handler(async (req: AuthedRequest, res) => {
    if (!githubConfigured()) {
      throw badRequest(
        'Discovery needs a GITHUB_TOKEN. Without one GitHub allows only 60 requests per hour, ' +
          'which is not enough to build a corpus.',
      );
    }

    const { job, deduped } = await enqueue({
      kind: 'discover',
      target: req.body.query,
      orgId: req.org!.id,
      requestedBy: req.user!.id,
      priority: 5,
      payload: { perPage: req.body.perPage },
    });
    await audit(req, 'ingest.enqueued', { type: 'job', id: job.id }, { query: req.body.query });
    res.status(deduped ? 200 : 202).json({ job, deduped });
  }),
);

/** Job history for this workspace, newest first. */
ingest.get(
  '/jobs',
  requirePermission('ingest:enqueue'),
  validate(
    z.object({
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead', 'skipped']).optional(),
      limit: intParam(1, 100),
    }),
    'query',
  ),
  handler(async (req: AuthedRequest, res) => {
    const q = req.query as { status?: string; limit?: number };

    // ingest_jobs is infrastructure and sits outside RLS (migration 0005), so
    // the org predicate here is the only thing scoping it - it is not optional.
    const { rows } = await query(
      `SELECT id, kind, target, status, priority, attempts, max_attempts,
              last_error, result, run_after, started_at, finished_at, created_at
         FROM ingest_jobs
        WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [req.org!.id, q.status ?? null, q.limit ?? 50],
      'ingest.jobs',
    );
    res.json({ jobs: rows, stats: await stats(req.org!.id) });
  }),
);

ingest.get(
  '/jobs/:id',
  requirePermission('ingest:enqueue'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(
      `SELECT * FROM ingest_jobs WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.org!.id],
      'ingest.job',
    );
    if (!rows.length) throw notFound('No such job.');
    res.json(rows[0]);
  }),
);

/** Put a dead job back on the queue with a fresh attempt budget. */
ingest.post(
  '/jobs/:id/retry',
  requirePermission('ingest:enqueue'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(
      `UPDATE ingest_jobs
          SET status = 'queued', attempts = 0, last_error = NULL, run_after = now()
        WHERE id = $1 AND org_id = $2 AND status IN ('dead','failed','skipped')
        RETURNING *`,
      [req.params.id, req.org!.id],
      'ingest.retry',
    );
    if (!rows.length) throw notFound('No retryable job with that id.');
    res.json(rows[0]);
  }),
);

/** Operational snapshot for the ingestion dashboard. */
ingest.get(
  '/status',
  requirePermission('ingest:enqueue'),
  handler(async (req: AuthedRequest, res) => {
    const [corpus, queue] = await Promise.all([
      query(
        `SELECT count(*)::int AS developers,
                count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
                count(*) FILTER (WHERE embedding_model IS DISTINCT FROM $1)::int AS stale_embeddings,
                count(*) FILTER (WHERE is_synthetic)::int AS synthetic,
                max(fetched_at) AS last_ingest
           FROM developers`,
        [activeModel()],
        'ingest.corpus_status',
      ),
      stats(req.org!.id),
    ]);

    let github = null;
    try {
      github = await rateLimitStatus();
    } catch {
      // A rate-limit lookup that itself fails must not break the dashboard.
      github = null;
    }

    res.json({
      corpus: corpus.rows[0],
      queue,
      github,
      embeddingModel: activeModel(),
      githubConfigured: githubConfigured(),
    });
  }),
);
