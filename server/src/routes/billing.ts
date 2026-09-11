import { Router, raw } from 'express';
import { handler, AppError, badRequest } from '../lib/errors.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { validate, z } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import {
  createCheckout,
  createPortal,
  verifyWebhook,
  handleEvent,
  billingEnabled,
} from '../services/stripe.js';
import { log } from '../lib/logger.js';
import { query } from '../db/pool.js';

export const billing = Router();

/**
 * Stripe webhook.
 *
 * Mounted with express.raw because signature verification hashes the exact
 * bytes Stripe sent - a JSON round trip through the global body parser would
 * reorder keys and change whitespace, and every signature would fail. The
 * parser in app.ts skips this path for the same reason.
 *
 * This route is deliberately NOT behind requireAuth: the caller is Stripe, and
 * the signature is the authentication.
 */
billing.post(
  '/webhook',
  raw({ type: 'application/json', limit: '1mb' }),
  handler(async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      throw badRequest('Missing Stripe signature header.');
    }

    let event;
    try {
      event = verifyWebhook(req.body as Buffer, signature);
    } catch (e) {
      // 400 tells Stripe the delivery failed so it retries.
      log().warn({ err: (e as Error).message }, 'stripe webhook signature rejected');
      throw badRequest(`Webhook signature verification failed: ${(e as Error).message}`);
    }

    // Acknowledge before doing slow work? No - Stripe retries on non-2xx, and
    // an error here means the state was NOT applied, which is exactly when a
    // retry is wanted.
    const result = await handleEvent(event);
    res.json({ received: true, ...result });
  }),
);

billing.use(requireAuth, requireOrg);

billing.post(
  '/checkout',
  requirePermission('billing:manage'),
  validate(z.object({ plan: z.enum(['team', 'scale']) })),
  handler(async (req: AuthedRequest, res) => {
    if (!billingEnabled()) {
      throw new AppError(503, 'Billing is not enabled on this deployment.', 'billing_disabled');
    }
    const url = await createCheckout(req.org!, req.user!.email, req.body.plan);
    await audit(req, 'billing.checkout_started', { type: 'org', id: req.org!.id }, {
      plan: req.body.plan,
    });
    res.json({ url });
  }),
);

billing.post(
  '/portal',
  requirePermission('billing:manage'),
  handler(async (req: AuthedRequest, res) => {
    if (!billingEnabled()) {
      throw new AppError(503, 'Billing is not enabled on this deployment.', 'billing_disabled');
    }
    const url = await createPortal(req.org!.id);
    await audit(req, 'billing.portal_opened', { type: 'org', id: req.org!.id });
    res.json({ url });
  }),
);

/** Current subscription state, read from our projection of Stripe's truth. */
billing.get(
  '/',
  requirePermission('billing:manage'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(
      `SELECT plan, subscription_status, current_period_end, cancel_at_period_end,
              seats, stripe_customer_id IS NOT NULL AS has_billing_account
         FROM orgs WHERE id = $1`,
      [req.org!.id],
      'billing.state',
    );
    res.json({ ...rows[0], enabled: billingEnabled() });
  }),
);
