import { Router } from 'express';
import { handler, conflict, unauthorized, badRequest, notFound } from '../lib/errors.js';
import { query, transaction, asTenant } from '../db/pool.js';
import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  setOrgCookie,
  clearAuthCookies,
  requireAuth,
  hashToken,
  type AuthedRequest,
} from '../lib/auth.js';
import { entitlement, PLANS, PLAN_IDS, publicLimits } from '../lib/plans.js';
import { permissionsFor } from '../lib/rbac.js';
import { currentUsage } from '../lib/usage.js';
import { validate, z, email, password, slug } from '../lib/validate.js';
import { rateLimit } from '../lib/ratelimit.js';
import { audit } from '../services/audit.js';
import { env } from '../config/env.js';

export const auth = Router();

/**
 * Everything the web app needs to render a signed-in session in one payload:
 * identity, the active workspace, the role, the permissions that role grants,
 * the plan entitlement and today's usage. One round trip on boot rather than
 * five, and the client never has to re-derive permissions from the role.
 */
async function sessionPayload(req: AuthedRequest) {
  const org = req.org;
  const plan = org ? entitlement(org.plan, org.subscription_status) : PLANS.free;
  const usage = org ? await currentUsage(org.id) : null;

  return {
    user: req.user,
    memberships: req.memberships ?? [],
    org: org
      ? {
          id: org.id,
          name: org.name,
          slug: org.slug,
          plan: org.plan,
          entitledPlan: plan.id,
          planName: plan.name,
          subscriptionStatus: org.subscription_status,
          currentPeriodEnd: org.current_period_end,
          cancelAtPeriodEnd: org.cancel_at_period_end,
          seats: org.seats,
          limits: publicLimits(plan.limits),
        }
      : null,
    role: req.role ?? null,
    permissions: permissionsFor(req.role),
    usage,
    features: {
      billing: env.features.billing,
      github: env.features.github,
      llm: env.features.llm,
      demoMode: env.DEMO_MODE,
    },
  };
}

const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(120).optional(),
  orgName: z.string().trim().min(2).max(80).optional(),
  /** Accepting an invitation instead of creating a new workspace. */
  inviteToken: z.string().min(10).optional(),
});

/** Derives a unique slug from a workspace name. */
async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'workspace';

  const padded = base.length < 3 ? `${base}-team` : base;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? padded : `${padded}-${i + 1}`;
    const { rowCount } = await query(`SELECT 1 FROM orgs WHERE slug = $1`, [candidate]);
    if (!rowCount) return candidate;
  }
  return `${padded}-${Date.now().toString(36)}`;
}

auth.post(
  '/register',
  rateLimit({ name: 'register', windowSeconds: 3600, max: 10 }),
  validate(registerSchema),
  handler(async (req: AuthedRequest, res) => {
    const { email: mail, password: pw, name, orgName, inviteToken } = req.body;

    const existing = await query(`SELECT 1 FROM users WHERE email = $1`, [mail]);
    if (existing.rowCount) throw conflict('An account with that email already exists.');

    const passwordHash = await hashPassword(pw);

    const { userId, orgId } = await transaction(async (db) => {
      const { rows: u } = await db.query(
        `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`,
        [mail, passwordHash, name ?? null],
      );
      const newUserId = u[0].id as string;

      // Path A: joining an existing workspace through an invitation.
      if (inviteToken) {
        const { rows: inv } = await db.query(
          `SELECT id, org_id, role, email, expires_at, accepted_at
             FROM invites WHERE token_hash = $1`,
          [hashToken(inviteToken)],
        );
        const invite = inv[0];
        if (!invite) throw badRequest('That invitation link is not valid.');
        if (invite.accepted_at) throw conflict('That invitation has already been used.');
        if (new Date(invite.expires_at) < new Date()) throw badRequest('That invitation has expired.');
        if (invite.email.toLowerCase() !== mail) {
          throw badRequest(`That invitation was sent to ${invite.email}.`);
        }

        await db.query(
          `INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)`,
          [invite.org_id, newUserId, invite.role],
        );
        await db.query(
          `UPDATE invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1`,
          [invite.id, newUserId],
        );
        return { userId: newUserId, orgId: invite.org_id as string };
      }

      // Path B: creating a brand new workspace, as its owner.
      const workspaceName = orgName?.trim() || `${name || mail.split('@')[0]}'s workspace`;
      const { rows: o } = await db.query(
        `INSERT INTO orgs (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [workspaceName, await uniqueSlug(workspaceName), newUserId],
      );
      const newOrgId = o[0].id as string;

      await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [
        newOrgId,
        newUserId,
      ]);
      return { userId: newUserId, orgId: newOrgId };
    });

    // A workspace with no pipeline is a dead end on first login.
    await asTenant(orgId, (db) =>
      db.query(
        `INSERT INTO lists (org_id, name, description, is_default, created_by)
         VALUES ($1, 'My shortlist', 'Candidates you have saved.', true, $2)
         ON CONFLICT (org_id, name) DO NOTHING`,
        [orgId, userId],
      ),
    );

    setSessionCookie(res, signSession(userId));
    setOrgCookie(res, orgId);

    req.user = { id: userId, email: mail, name: name ?? null, avatar_url: null };
    res.status(201).json({ ok: true });
  }),
);

auth.post(
  '/login',
  // Brute-force guard, keyed by IP. Deliberately tighter than the global limit.
  rateLimit({ name: 'login', windowSeconds: 900, max: 20 }),
  validate(z.object({ email, password: z.string().min(1) })),
  handler(async (req, res) => {
    const { email: mail, password: pw } = req.body;

    const { rows } = await query(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [mail],
      'auth.login_lookup',
    );
    const user = rows[0];

    // Identical response for "no such account" and "wrong password", so the
    // endpoint cannot be used to enumerate which emails are registered.
    if (!user || !(await verifyPassword(pw, user.password_hash))) {
      throw unauthorized('Incorrect email or password.');
    }

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    const { rows: m } = await query(
      `SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [user.id],
    );

    setSessionCookie(res, signSession(user.id));
    if (m[0]) setOrgCookie(res, m[0].org_id);

    res.json({ ok: true });
  }),
);

auth.post('/logout', (_req, res) => {
  clearAuthCookies(res);
  res.status(204).end();
});

auth.get(
  '/session',
  requireAuth,
  handler(async (req: AuthedRequest, res) => {
    res.json(await sessionPayload(req));
  }),
);

/** Switch the active workspace. Membership is re-checked server side. */
auth.post(
  '/switch-org',
  requireAuth,
  validate(z.object({ orgId: z.string().min(1) })),
  handler(async (req: AuthedRequest, res) => {
    const target = req.memberships?.find(
      (m) => m.orgId === req.body.orgId || m.slug === req.body.orgId,
    );
    if (!target) throw notFound('You are not a member of that workspace.');

    setOrgCookie(res, target.orgId);
    res.json({ ok: true, orgId: target.orgId });
  }),
);

auth.post(
  '/change-password',
  requireAuth,
  rateLimit({ name: 'change-password', windowSeconds: 3600, max: 10 }),
  validate(z.object({ currentPassword: z.string().min(1), newPassword: password })),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
    if (!(await verifyPassword(req.body.currentPassword, rows[0].password_hash))) {
      throw unauthorized('Your current password is not correct.');
    }
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      await hashPassword(req.body.newPassword),
      req.user!.id,
    ]);
    await audit(req, 'org.updated', undefined, { change: 'password' });
    res.status(204).end();
  }),
);

/** Create an additional workspace while already signed in. */
auth.post(
  '/orgs',
  requireAuth,
  validate(z.object({ name: z.string().trim().min(2).max(80), slug: slug.optional() })),
  handler(async (req: AuthedRequest, res) => {
    const name = req.body.name as string;
    const desired = (req.body.slug as string | undefined) ?? (await uniqueSlug(name));

    const taken = await query(`SELECT 1 FROM orgs WHERE slug = $1`, [desired]);
    if (taken.rowCount) throw conflict('That workspace URL is taken.');

    const orgId = await transaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO orgs (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [name, desired, req.user!.id],
      );
      const id = rows[0].id as string;
      await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [
        id,
        req.user!.id,
      ]);
      return id;
    });

    await asTenant(orgId, (db) =>
      db.query(
        `INSERT INTO lists (org_id, name, description, is_default, created_by)
         VALUES ($1, 'My shortlist', 'Candidates you have saved.', true, $2)`,
        [orgId, req.user!.id],
      ),
    );

    setOrgCookie(res, orgId);
    res.status(201).json({ id: orgId, name, slug: desired });
  }),
);

/** Public plan catalogue for the pricing page. */
auth.get('/plans', (_req, res) => {
  res.json(
    PLAN_IDS.map((id) => {
      const p = PLANS[id];
      return {
        id: p.id,
        name: p.name,
        blurb: p.blurb,
        priceLabel: p.priceLabel,
        priceMonthly: p.priceMonthly,
        trialDays: p.trialDays,
        features: p.features,
        limits: publicLimits(p.limits),
        // False when no Stripe price is configured, so the UI can say so
        // instead of opening a checkout that would fail.
        purchasable: Boolean(p.priceId) && env.features.billing,
      };
    }),
  );
});
