import Stripe from 'stripe';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { PLANS, planByPriceId, type PlanId } from '../lib/plans.js';
import type { ActiveOrg } from '../lib/auth.js';

/**
 * Stripe subscription lifecycle.
 *
 * The rule that keeps billing state correct: Stripe is the source of truth,
 * and the database is a projection of it. Nothing here writes a plan because
 * the app thinks a purchase succeeded - the plan changes only when a webhook
 * reports what Stripe actually did. That is why the checkout route does not
 * optimistically upgrade the org: a user who closes the tab mid-payment would
 * otherwise end up entitled to a plan they never bought.
 */

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) {
    if (!env.STRIPE_SECRET_KEY)
      throw new AppError(503, 'Billing is not configured on this server.');

    client = new Stripe(env.STRIPE_SECRET_KEY, {
      // Pinned so a Stripe-side API change cannot alter behaviour without a
      // deliberate upgrade here. The SDK's types only accept the version that
      // release pins (`Stripe.LatestApiVersion`), so this literal has to move
      // in step with the `stripe` dependency - which is the point: the bump is
      // a visible edit rather than a silent drift to the account default.
      apiVersion: '2025-02-24.acacia',
      appInfo: { name: 'DevScout', version: '2.0.0' },
      maxNetworkRetries: 2,
    });
  }
  return client;
}

export const billingEnabled = (): boolean => Boolean(env.STRIPE_SECRET_KEY);

async function customerFor(org: ActiveOrg, email: string): Promise<string> {
  const { rows } = await query(`SELECT stripe_customer_id FROM orgs WHERE id = $1`, [org.id]);
  const existing = rows[0]?.stripe_customer_id as string | undefined;
  if (existing) return existing;

  const customer = await stripe().customers.create({
    name: org.name,
    email,
    // The org id travels with the customer so a webhook can always find its
    // way home, even if the local row is missing the customer id.
    metadata: { orgId: org.id },
  });

  await query(`UPDATE orgs SET stripe_customer_id = $1 WHERE id = $2`, [customer.id, org.id]);
  return customer.id;
}

export async function createCheckout(
  org: ActiveOrg,
  email: string,
  planId: PlanId,
): Promise<string> {
  const plan = PLANS[planId];
  if (!plan.priceId)
    throw badRequest(`The ${plan.name} plan is not purchasable on this deployment.`);

  const customerId = await customerFor(org, email);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    subscription_data: {
      ...(plan.trialDays > 0 ? { trial_period_days: plan.trialDays } : {}),
      metadata: { orgId: org.id, planId },
    },
    // Repeated on the session too: subscription metadata is not present on
    // every event type the webhook handles.
    metadata: { orgId: org.id, planId },
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    success_url: `${env.WEB_ORIGIN}/account?checkout=success`,
    cancel_url: `${env.WEB_ORIGIN}/pricing?checkout=cancelled`,
  });

  if (!session.url) throw new AppError(502, 'Stripe did not return a checkout URL.');
  return session.url;
}

export async function createPortal(orgId: string): Promise<string> {
  const { rows } = await query(`SELECT stripe_customer_id FROM orgs WHERE id = $1`, [orgId]);
  const customerId = rows[0]?.stripe_customer_id as string | undefined;
  if (!customerId) throw badRequest('This workspace has no billing account yet.');

  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.WEB_ORIGIN}/account`,
  });
  return session.url;
}

/**
 * Projects a Stripe subscription onto the org row.
 *
 * The plan is derived from the price id actually on the subscription, not from
 * what the app asked for at checkout. If someone switches plan in the billing
 * portal, the price is the only thing that tells the truth about it.
 */
async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const priceId = sub.items.data[0]?.price?.id ?? null;
  const planId = planByPriceId(priceId);

  // A canceled subscription drops the org to Free but keeps all their data.
  const effectivePlan: PlanId = sub.status === 'canceled' ? 'free' : planId;

  // period_end moved onto the subscription item in newer API versions; read
  // whichever is present rather than assuming.
  const periodEnd =
    (sub as unknown as { current_period_end?: number | null }).current_period_end ??
    (sub.items.data[0] as unknown as { current_period_end?: number | null } | undefined)
      ?.current_period_end ??
    null;

  const { rowCount } = await query(
    `UPDATE orgs
        SET plan = $1,
            subscription_status = $2,
            stripe_subscription_id = $3,
            cancel_at_period_end = $4,
            current_period_end = CASE WHEN $5::bigint IS NULL THEN NULL
                                      ELSE to_timestamp($5::bigint) END,
            seats = GREATEST(seats, $6)
      WHERE stripe_customer_id = $7`,
    [
      effectivePlan,
      sub.status,
      sub.id,
      sub.cancel_at_period_end ?? false,
      periodEnd,
      PLANS[effectivePlan]?.limits.seats ?? 1,
      customerId,
    ],
    'stripe.apply_subscription',
  );

  if (!rowCount) {
    // The customer has no matching org - recoverable via metadata.
    const orgId = sub.metadata?.orgId || null;
    if (orgId) {
      await query(`UPDATE orgs SET stripe_customer_id = $1 WHERE id = $2`, [customerId, orgId]);
      await query(
        `UPDATE orgs SET plan = $1, subscription_status = $2, stripe_subscription_id = $3 WHERE id = $4`,
        [effectivePlan, sub.status, sub.id, orgId],
      );
      log().warn({ orgId, customerId }, 'relinked Stripe customer to org from metadata');
    } else {
      log().error({ customerId, subscriptionId: sub.id }, 'webhook for unknown customer');
    }
  }

  log().info(
    { customerId, plan: effectivePlan, status: sub.status },
    'subscription state applied',
  );
}

/**
 * Handles one verified webhook event, exactly once.
 *
 * Stripe guarantees at-least-once delivery, and retries are common, so the
 * event id is recorded first. If the insert conflicts the event has already
 * been applied and this delivery is a duplicate - returning early is what
 * makes a replayed `subscription.deleted` harmless.
 */
export async function handleEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
  const { rowCount } = await query(
    `INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type],
    'stripe.record_event',
  );

  if (!rowCount) {
    log().info({ eventId: event.id, type: event.type }, 'duplicate webhook ignored');
    return { handled: false };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const sub = await stripe().subscriptions.retrieve(session.subscription as string);
        await applySubscription(sub);
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
    case 'customer.subscription.trial_will_end': {
      await applySubscription(event.data.object as Stripe.Subscription);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        // past_due is not a hard lock: entitlement() falls back to Free, so
        // the team keeps its data and sees a prompt to fix payment.
        await query(
          `UPDATE orgs SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`,
          [customerId],
        );
        log().warn({ customerId }, 'invoice payment failed');
      }
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = (invoice as unknown as { subscription?: string | Stripe.Subscription | null })
        .subscription;
      if (subId) {
        await applySubscription(
          await stripe().subscriptions.retrieve(
            typeof subId === 'string' ? subId : subId.id,
          ),
        );
      }
      break;
    }

    default:
      log().debug({ type: event.type }, 'unhandled stripe event');
      return { handled: false };
  }

  return { handled: true };
}

export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(500, 'STRIPE_WEBHOOK_SECRET is not configured.');
  }
  return stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
