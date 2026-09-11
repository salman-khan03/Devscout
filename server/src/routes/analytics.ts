import { Router } from 'express';
import { handler } from '../lib/errors.js';
import { asTenant } from '../db/pool.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { requireFeature, currentUsage } from '../lib/usage.js';
import { validate, z, intParam } from '../lib/validate.js';
import { entitlement, publicLimits } from '../lib/plans.js';
import { stats as queueStats } from '../lib/queue.js';

export const analytics = Router();

analytics.use(requireAuth, requireOrg);

/**
 * Sourcing analytics.
 *
 * Every query reads RLS-protected tables through a tenant-pinned connection,
 * including the two views from migration 0006 - they are declared
 * security_invoker precisely so the policies follow through into the view.
 *
 * The whole dashboard is one round trip. Six separate endpoints would each pay
 * connection and RLS setup costs, and the client would have six loading states
 * to reconcile for a screen that is only meaningful as a whole.
 */
analytics.get(
  '/',
  requirePermission('analytics:read'),
  requireFeature('analytics', 'The analytics dashboard'),
  validate(z.object({ days: intParam(1, 365) }), 'query'),
  handler(async (req: AuthedRequest, res) => {
    const days = (req.query as { days?: number }).days ?? 30;
    const orgId = req.org!.id;

    const data = await asTenant(orgId, async (db) => {
      const [funnel, searches, topQueries, zeroResults, languages, team, stages, timeline] =
        await Promise.all([
          // Sourcing funnel: viewed -> shortlisted -> advanced.
          db.query(
            `SELECT
               count(*) FILTER (WHERE action = 'viewed')::int       AS viewed,
               count(*) FILTER (WHERE action = 'shortlisted')::int  AS shortlisted,
               count(*) FILTER (WHERE action = 'staged')::int       AS advanced,
               count(*) FILTER (WHERE action = 'exported')::int     AS exported,
               count(DISTINCT developer_id)::int                    AS unique_candidates
             FROM activity_events
            WHERE org_id = $1 AND created_at > now() - make_interval(days => $2)`,
            [orgId, days],
            'analytics.funnel',
          ),
          // Search volume and latency, straight off the view.
          db.query(
            `SELECT day, searches, avg_took_ms, p95_took_ms, avg_results, zero_result_searches
               FROM org_search_daily
              WHERE org_id = $1 AND day > CURRENT_DATE - $2::int
              ORDER BY day`,
            [orgId, days],
            'analytics.searches',
          ),
          db.query(
            `SELECT query, count(*)::int AS runs, avg(result_count)::int AS avg_results
               FROM search_events
              WHERE org_id = $1 AND query <> '' AND created_at > now() - make_interval(days => $2)
              GROUP BY query ORDER BY runs DESC LIMIT 10`,
            [orgId, days],
            'analytics.top_queries',
          ),
          // Queries that found nobody: the clearest signal of a corpus gap.
          db.query(
            `SELECT query, count(*)::int AS runs
               FROM search_events
              WHERE org_id = $1 AND result_count = 0 AND query <> ''
                AND created_at > now() - make_interval(days => $2)
              GROUP BY query ORDER BY runs DESC LIMIT 10`,
            [orgId, days],
            'analytics.zero_results',
          ),
          // What the pipeline is actually made of.
          db.query(
            `SELECT l->>'language' AS language, count(DISTINCT lm.developer_id)::int AS candidates
               FROM list_members lm
               JOIN developers d ON d.id = lm.developer_id
               CROSS JOIN LATERAL jsonb_array_elements(d.languages) l
              WHERE lm.org_id = $1 AND (l->>'pct')::float > 15
              GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
            [orgId],
            'analytics.languages',
          ),
          db.query(
            `SELECT u.name, u.email,
                    count(*) FILTER (WHERE a.action = 'viewed')::int      AS viewed,
                    count(*) FILTER (WHERE a.action = 'shortlisted')::int AS shortlisted,
                    count(*) FILTER (WHERE a.action = 'staged')::int      AS advanced
               FROM activity_events a JOIN users u ON u.id = a.user_id
              WHERE a.org_id = $1 AND a.created_at > now() - make_interval(days => $2)
              GROUP BY u.id, u.name, u.email
              ORDER BY shortlisted DESC LIMIT 10`,
            [orgId, days],
            'analytics.team',
          ),
          db.query(
            `SELECT stage, count(*)::int AS n FROM list_members
              WHERE org_id = $1 GROUP BY stage`,
            [orgId],
            'analytics.stages',
          ),
          db.query(
            `SELECT day, viewed, shortlisted, staged, unique_developers, active_users
               FROM org_funnel_daily
              WHERE org_id = $1 AND day > CURRENT_DATE - $2::int
              ORDER BY day`,
            [orgId, days],
            'analytics.timeline',
          ),
        ]);

      return {
        funnel: funnel.rows[0],
        searchVolume: searches.rows,
        topQueries: topQueries.rows,
        zeroResultQueries: zeroResults.rows,
        pipelineLanguages: languages.rows,
        teamActivity: team.rows,
        stageBreakdown: stages.rows,
        timeline: timeline.rows,
      };
    });

    const plan = entitlement(req.org!.plan, req.org!.subscription_status);

    // Conversion rates computed here rather than in the client, so every
    // surface that shows them agrees on the denominator.
    const f = data.funnel;
    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

    res.json({
      ...data,
      days,
      conversion: {
        viewToShortlist: rate(f.shortlisted, f.viewed),
        shortlistToAdvanced: rate(f.advanced, f.shortlisted),
      },
      usage: await currentUsage(orgId),
      limits: publicLimits(plan.limits),
      queue: await queueStats(orgId),
    });
  }),
);
