import { Router } from 'express';
import { handler, notFound, badRequest } from '../lib/errors.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { consume } from '../lib/usage.js';
import { rateLimit } from '../lib/ratelimit.js';
import { validate, z, csv, githubLogin } from '../lib/validate.js';
import { tquery, query } from '../db/pool.js';
import { getDeveloper, ingestLogin } from '../services/corpus.js';
import { track } from '../services/audit.js';
import { githubConfigured } from '../services/github.js';
import { enqueue } from '../lib/queue.js';

export const candidates = Router();

candidates.use(requireAuth, requireOrg);

/** Tenant-scoped annotations layered onto a shared corpus profile. */
async function annotations(orgId: string, developerId: string) {
  const { rows } = await tquery(
    orgId,
    `SELECT
       (SELECT json_agg(t ORDER BY t.created_at)
          FROM (SELECT id, label, created_at FROM tags
                 WHERE org_id = $1 AND developer_id = $2) t) AS tags,
       (SELECT json_agg(n ORDER BY n.created_at DESC)
          FROM (SELECT n.id, n.body, n.created_at, n.updated_at,
                       u.name AS author_name, u.email AS author_email
                  FROM notes n LEFT JOIN users u ON u.id = n.author_id
                 WHERE n.org_id = $1 AND n.developer_id = $2) n) AS notes,
       (SELECT json_agg(m)
          FROM (SELECT lm.id, lm.list_id, l.name AS list_name, lm.stage, lm.rating, lm.added_at
                  FROM list_members lm JOIN lists l ON l.id = lm.list_id
                 WHERE lm.org_id = $1 AND lm.developer_id = $2) m) AS memberships`,
    [orgId, developerId],
    'candidates.annotations',
  );
  const r = rows[0];
  return {
    tags: r.tags ?? [],
    notes: r.notes ?? [],
    lists: r.memberships ?? [],
  };
}

/**
 * GET /api/candidates/:login
 *
 * Reads from the corpus. A profile that is not there yet is ingested inline
 * when a GitHub token is configured, so a recruiter pasting a handle gets an
 * answer instead of a dead end. That inline path is what the scan meter
 * counts - re-opening a cached profile is free, which keeps the plan limit
 * tied to work actually done rather than to page views.
 */
candidates.get(
  '/:login',
  requirePermission('candidate:view'),
  rateLimit({ name: 'profile', windowSeconds: 60, max: 120, by: 'org' }),
  validate(z.object({ login: githubLogin }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const login = req.params.login;
    const existing = await getDeveloper(login);

    if (existing) {
      void track(req, 'viewed', existing.id, { login });
      return res.json({
        ...shape(existing),
        ...(await annotations(req.org!.id, existing.id)),
        source: 'corpus',
      });
    }

    if (!githubConfigured()) {
      throw notFound(
        `${login} is not in the corpus, and live GitHub lookup is off because no GITHUB_TOKEN is configured.`,
      );
    }

    // Not in the corpus: fetching it from GitHub is real work, so this path
    // costs a scan against the plan's daily allowance.
    await consume(req.org!, 'profile_scans');

    const result = await ingestLogin(login);
    const fresh = await getDeveloper(result.login);
    if (!fresh) throw notFound('Could not build that profile.');

    void track(req, 'viewed', fresh.id, { login, ingested: true });
    res.json({
      ...shape(fresh),
      ...(await annotations(req.org!.id, fresh.id)),
      source: 'github',
    });
  }),
);

/**
 * GET /api/candidates/compare?logins=a,b,c
 *
 * Side-by-side comparison. One query for all of them rather than N round
 * trips, and the shared dimensions are computed here so the client renders a
 * matrix instead of reconciling four differently-shaped profiles.
 */
candidates.get(
  '/',
  requirePermission('candidate:view'),
  validate(z.object({ logins: csv }), 'query'),
  handler(async (req: AuthedRequest, res) => {
    const logins = (req.query as { logins?: string[] }).logins ?? [];
    if (logins.length < 2) throw badRequest('Pass at least two logins to compare.');
    if (logins.length > 4) throw badRequest('Compare at most four candidates at a time.');

    const { rows } = await query(
      `SELECT * FROM developers WHERE lower(login) = ANY($1::text[])`,
      [logins.map((l) => l.toLowerCase())],
      'candidates.compare',
    );
    if (!rows.length) throw notFound('None of those candidates are in the corpus.');

    const profiles = await Promise.all(
      rows.map(async (r) => ({
        ...shape(r),
        ...(await annotations(req.org!.id, r.id)),
      })),
    );

    // The union of every language any of them uses, so the comparison table
    // has one row per language with gaps where a candidate does not use it.
    const languageAxis = [
      ...new Set(profiles.flatMap((p) => p.languages.map((l: { language: string }) => l.language))),
    ].slice(0, 12);
    const topicAxis = [...new Set(profiles.flatMap((p) => p.topics))].slice(0, 15);

    void track(req, 'compared', null, { logins });

    res.json({
      profiles,
      axes: {
        languages: languageAxis,
        topics: topicAxis,
        metrics: [
          { key: 'totalStars', label: 'Total stars' },
          { key: 'followers', label: 'Followers' },
          { key: 'originalRepos', label: 'Original repos' },
          { key: 'recentPushes', label: 'Pushes (90d)' },
          { key: 'activityScore', label: 'Activity score' },
          { key: 'impactScore', label: 'Impact score' },
        ],
      },
    });
  }),
);

/** Queue a background refresh of a profile. */
candidates.post(
  '/:login/refresh',
  requirePermission('ingest:enqueue'),
  validate(z.object({ login: githubLogin }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { job, deduped } = await enqueue({
      kind: 'profile',
      target: req.params.login,
      orgId: req.org!.id,
      requestedBy: req.user!.id,
      priority: 3,
      payload: { refresh: true },
    });
    res.status(deduped ? 200 : 202).json({ jobId: job.id, status: job.status, deduped });
  }),
);

/** Maps a corpus row onto the API shape the web app consumes. */
function shape(d: any) {
  return {
    id: d.id,
    login: d.login,
    name: d.name,
    avatarUrl: d.avatar_url,
    htmlUrl: d.html_url,
    bio: d.bio,
    location: d.location,
    company: d.company,
    blog: d.blog,
    hireable: d.hireable,
    followers: d.followers,
    following: d.following,
    publicRepos: d.public_repos,
    githubCreatedAt: d.github_created_at,
    languages: d.languages ?? [],
    topics: d.topics ?? [],
    signals: d.signals ?? {},
    totalStars: d.total_stars,
    totalForks: d.total_forks,
    originalRepos: d.original_repos,
    recentPushes: d.recent_pushes,
    lastActiveAt: d.last_active_at,
    activityScore: d.activity_score,
    impactScore: d.impact_score,
    seniority: d.seniority,
    summary: d.summary,
    roleFit: d.role_fit,
    summarySource: d.summary_source,
    isSynthetic: d.is_synthetic,
    fetchedAt: d.fetched_at,
    updatedAt: d.updated_at,
    repos: d.repos ?? [],
  };
}
