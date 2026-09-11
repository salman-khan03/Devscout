import { env } from '../config/env.js';

/**
 * Plan catalogue. Limits live here so gating, the pricing page and the usage
 * meters all read one definition. Stripe price IDs come from the environment -
 * you create the products in the Stripe dashboard and paste the ids in.
 */
export type PlanId = 'free' | 'team' | 'scale';

export interface PlanLimits {
  /** Full profile scans per day. A cached re-open does not count. */
  scansPerDay: number;
  /** Searches per day across the whole org. */
  searchesPerDay: number;
  /** Candidates saved across all lists. */
  savedCandidates: number;
  seats: number;
  /** Ingestion jobs an org may enqueue per day. */
  ingestJobsPerDay: number;
  csvExport: boolean;
  savedSearches: number;
  analytics: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  blurb: string;
  priceLabel: string;
  priceMonthly: number;
  priceId: string | null;
  trialDays: number;
  limits: PlanLimits;
  features: string[];
}

const UNLIMITED = Number.MAX_SAFE_INTEGER;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    blurb: 'For one recruiter trying the product.',
    priceLabel: '$0',
    priceMonthly: 0,
    priceId: null,
    trialDays: 0,
    limits: {
      scansPerDay: 25,
      searchesPerDay: 100,
      savedCandidates: 50,
      seats: 1,
      ingestJobsPerDay: 20,
      csvExport: false,
      savedSearches: 3,
      analytics: false,
    },
    features: [
      '25 profile scans per day',
      '100 searches per day',
      'Save up to 50 candidates',
      '3 saved searches',
      '1 seat',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    blurb: 'For a recruiting team running live pipelines.',
    priceLabel: '$49/mo',
    priceMonthly: 49,
    priceId: env.STRIPE_PRICE_TEAM ?? null,
    trialDays: env.TRIAL_DAYS,
    limits: {
      scansPerDay: 500,
      searchesPerDay: 2000,
      savedCandidates: 2500,
      seats: 8,
      ingestJobsPerDay: 500,
      csvExport: true,
      savedSearches: 50,
      analytics: true,
    },
    features: [
      '500 profile scans per day',
      'Up to 8 seats with roles',
      'Unlimited pipelines, 2,500 saved candidates',
      'CSV export',
      'Sourcing analytics dashboard',
      'Background GitHub ingestion',
    ],
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    blurb: 'For agencies sourcing at volume.',
    priceLabel: '$199/mo',
    priceMonthly: 199,
    priceId: env.STRIPE_PRICE_SCALE ?? null,
    trialDays: env.TRIAL_DAYS,
    limits: {
      scansPerDay: UNLIMITED,
      searchesPerDay: UNLIMITED,
      savedCandidates: UNLIMITED,
      seats: 50,
      ingestJobsPerDay: 5000,
      csvExport: true,
      savedSearches: UNLIMITED,
      analytics: true,
    },
    features: [
      'Unlimited scans and searches',
      'Up to 50 seats',
      'Unlimited saved candidates and searches',
      '5,000 ingestion jobs per day',
      'Everything in Team',
    ],
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

/** Statuses under which a paid plan is actually entitled. */
const LIVE = new Set(['active', 'trialing']);

/**
 * The plan an org may currently use. A past_due or canceled subscription falls
 * back to Free rather than cutting access off entirely - the recruiter keeps
 * their data and sees an upgrade prompt instead of a locked account.
 */
export function entitlement(plan: string, status: string): Plan {
  if (plan !== 'free' && LIVE.has(status) && PLANS[plan as PlanId]) {
    return PLANS[plan as PlanId];
  }
  return PLANS.free;
}

export function planByPriceId(priceId: string | null | undefined): PlanId {
  if (!priceId) return 'free';
  const match = PLAN_IDS.find((id) => PLANS[id].priceId && PLANS[id].priceId === priceId);
  return match ?? 'free';
}

/** Presentational form: Infinity does not survive JSON, so send a sentinel. */
export function publicLimits(l: PlanLimits) {
  const cap = (n: number) => (n >= UNLIMITED ? null : n); // null renders as "Unlimited"
  return {
    scansPerDay: cap(l.scansPerDay),
    searchesPerDay: cap(l.searchesPerDay),
    savedCandidates: cap(l.savedCandidates),
    seats: cap(l.seats),
    ingestJobsPerDay: cap(l.ingestJobsPerDay),
    savedSearches: cap(l.savedSearches),
    csvExport: l.csvExport,
    analytics: l.analytics,
  };
}
