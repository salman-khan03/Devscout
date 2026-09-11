import type { Response, NextFunction } from 'express';
import { asTenant, tquery } from '../db/pool.js';
import { paymentRequired } from './errors.js';
import { entitlement, type PlanLimits } from './plans.js';
import type { AuthedRequest } from './auth.js';

type Meter = 'profile_scans' | 'searches' | 'ingest_jobs' | 'exports';

/**
 * Plan metering.
 *
 * Counters are per-org per-day rows, incremented with an upsert so the check
 * and the increment are one atomic statement - two recruiters in the same org
 * clicking at once cannot both slip past the last unit of quota.
 *
 * The increment happens before the work, and the returned count is compared
 * against the limit afterwards. That can over-count a request that then fails
 * upstream; the alternative (count on success) lets a caller burn unlimited
 * quota by cancelling in flight. For a daily quota, over-counting a rare
 * failure is the cheaper mistake.
 */
async function bump(orgId: string, meter: Meter, by = 1): Promise<number> {
  const { rows } = await tquery<Record<Meter, number>>(
    orgId,
    `INSERT INTO usage_counters (org_id, day, ${meter})
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (org_id, day) DO UPDATE
       SET ${meter} = usage_counters.${meter} + EXCLUDED.${meter}
     RETURNING ${meter}`,
    [orgId, by],
    `usage.${meter}`,
  );
  return rows[0][meter];
}

export async function currentUsage(orgId: string) {
  const { rows } = await tquery(
    orgId,
    `SELECT profile_scans, searches, ingest_jobs, exports
       FROM usage_counters WHERE org_id = $1 AND day = CURRENT_DATE`,
    [orgId],
    'usage.read',
  );
  return rows[0] ?? { profile_scans: 0, searches: 0, ingest_jobs: 0, exports: 0 };
}


const LABEL: Record<Meter, string> = {
  profile_scans: 'profile scans',
  searches: 'searches',
  ingest_jobs: 'ingestion jobs',
  exports: 'exports',
};

const LIMIT_KEY: Record<Meter, keyof PlanLimits> = {
  profile_scans: 'scansPerDay',
  searches: 'searchesPerDay',
  ingest_jobs: 'ingestJobsPerDay',
  exports: 'scansPerDay',
};

/**
 * Consumes one unit of an org's daily allowance, throwing 402 when exhausted.
 *
 * Exposed as a plain function as well as middleware because some routes only
 * meter conditionally - opening a cached profile is free, while one that has
 * to be fetched from GitHub is not - and that decision can only be made part
 * way through the handler.
 */
export async function consume(
  org: { id: string; plan: string; subscription_status: string },
  which: Meter,
): Promise<void> {
  const plan = entitlement(org.plan, org.subscription_status);
  const limit = plan.limits[LIMIT_KEY[which]] as number;
  const used = await bump(org.id, which);

  if (used > limit) {
    throw paymentRequired(
      `Your ${plan.name} plan allows ${limit.toLocaleString()} ${LABEL[which]} per day. ` +
        'Upgrade for more headroom.',
      { meter: which, limit, used, plan: plan.id },
    );
  }
}

/** Middleware factory: meter a route against the org's daily allowance. */
export function meter(which: Meter) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      const org = req.org!;
      const plan = entitlement(org.plan, org.subscription_status);
      const limit = plan.limits[LIMIT_KEY[which]] as number;

      const used = await bump(org.id, which);
      if (used > limit) {
        throw paymentRequired(
          `Your ${plan.name} plan allows ${limit.toLocaleString()} ${LABEL[which]} per day. ` +
            'Upgrade for more headroom.',
          { meter: which, limit, used, plan: plan.id },
        );
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Gate a boolean plan feature (CSV export, analytics). */
export function requireFeature(feature: 'csvExport' | 'analytics', label: string) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const org = req.org!;
    const plan = entitlement(org.plan, org.subscription_status);
    if (!plan.limits[feature]) {
      return next(
        paymentRequired(`${label} is not included in the ${plan.name} plan.`, {
          feature,
          plan: plan.id,
        }),
      );
    }
    next();
  };
}

/** Count-based caps (saved candidates, saved searches, seats). */
export async function assertCapacity(
  orgId: string,
  plan: ReturnType<typeof entitlement>,
  what: 'savedCandidates' | 'savedSearches' | 'seats',
): Promise<void> {
  const limit = plan.limits[what] as number;

  const count = await asTenant(orgId, async (db) => {
    if (what === 'savedCandidates') {
      const { rows } = await db.query(
        `SELECT count(DISTINCT developer_id)::int AS n FROM list_members WHERE org_id = $1`,
        [orgId],
        'usage.saved_count',
      );
      return rows[0].n as number;
    }
    if (what === 'savedSearches') {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM saved_searches WHERE org_id = $1`,
        [orgId],
        'usage.saved_search_count',
      );
      return rows[0].n as number;
    }
    // memberships is outside RLS by design (see migration 0005) but the
    // predicate is still explicit.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1`,
      [orgId],
      'usage.seat_count',
    );
    return rows[0].n as number;
  });

  if (count >= limit) {
    const nouns = {
      savedCandidates: 'saved candidates',
      savedSearches: 'saved searches',
      seats: 'seats',
    } as const;
    throw paymentRequired(
      `The ${plan.name} plan includes ${limit.toLocaleString()} ${nouns[what]}. Upgrade to add more.`,
      { cap: what, limit, used: count, plan: plan.id },
    );
  }
}
