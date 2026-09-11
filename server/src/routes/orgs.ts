import { Router } from 'express';
import { handler, conflict, notFound, badRequest, forbidden } from '../lib/errors.js';
import { query, tquery, transaction } from '../db/pool.js';
import { requireAuth, requireOrg, newToken, hashToken, type AuthedRequest } from '../lib/auth.js';
import { requirePermission, canManageRole, ROLES, type RoleName } from '../lib/rbac.js';
import { entitlement } from '../lib/plans.js';
import { assertCapacity } from '../lib/usage.js';
import { validate, z, email, uuid } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { env } from '../config/env.js';

export const orgs = Router();

orgs.use(requireAuth, requireOrg);

/**
 * Membership, invitations and roles.
 *
 * Two invariants are enforced on every write, because both are ways a
 * workspace can be left unusable or escalated into:
 *
 *   1. An organisation always has at least one owner. Removing or demoting the
 *      last one is refused.
 *   2. Nobody may grant a role above their own, or modify a member at or above
 *      their own rank (owners excepted). See canManageRole in lib/rbac.ts.
 *
 * These tables sit outside row-level security by design - see migration 0005 -
 * so every statement below carries an explicit org predicate.
 */

orgs.get(
  '/members',
  requirePermission('member:read'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(
      `SELECT m.id, m.role, m.created_at,
              u.id AS user_id, u.email, u.name, u.avatar_url, u.last_login_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1
        ORDER BY (SELECT rank FROM roles WHERE name = m.role) DESC, u.email`,
      [req.org!.id],
      'orgs.members',
    );

    const { rows: pending } = await query(
      `SELECT id, email, role, expires_at, created_at
         FROM invites
        WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [req.org!.id],
      'orgs.invites',
    );

    const plan = entitlement(req.org!.plan, req.org!.subscription_status);
    res.json({
      members: rows,
      pendingInvites: pending,
      seatsUsed: rows.length,
      seatLimit: plan.limits.seats,
      roles: ROLES,
    });
  }),
);

orgs.post(
  '/invites',
  requirePermission('member:invite'),
  validate(z.object({ email, role: z.enum(['viewer', 'recruiter', 'admin', 'owner']) })),
  handler(async (req: AuthedRequest, res) => {
    const { email: invitee, role } = req.body as { email: string; role: RoleName };

    if (!canManageRole(req.role!, null, role)) {
      throw forbidden(`As ${req.role} you cannot grant the ${role} role.`);
    }

    const plan = entitlement(req.org!.plan, req.org!.subscription_status);
    await assertCapacity(req.org!.id, plan, 'seats');

    const already = await query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND u.email = $2`,
      [req.org!.id, invitee],
    );
    if (already.rowCount) throw conflict('That person is already a member.');

    // The raw token is returned once and never stored; only its hash is kept,
    // so a leaked database cannot be used to accept invitations.
    const token = newToken();

    const { rows } = await query(
      `INSERT INTO invites (org_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')
       ON CONFLICT (org_id, email) WHERE accepted_at IS NULL
       DO UPDATE SET role = EXCLUDED.role,
                     token_hash = EXCLUDED.token_hash,
                     invited_by = EXCLUDED.invited_by,
                     expires_at = EXCLUDED.expires_at,
                     created_at = now()
       RETURNING id, email, role, expires_at`,
      [req.org!.id, invitee, role, hashToken(token), req.user!.id],
      'orgs.create_invite',
    );

    await audit(req, 'member.invited', { type: 'invite', id: rows[0].id }, { email: invitee, role });

    res.status(201).json({
      invite: rows[0],
      // No email provider is wired up, so the link is handed back for the
      // inviter to share. Swapping in a mailer is the only change needed.
      acceptUrl: `${env.WEB_ORIGIN}/join?token=${token}`,
      delivery: 'manual',
    });
  }),
);

orgs.delete(
  '/invites/:id',
  requirePermission('member:invite'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rowCount } = await query(
      `DELETE FROM invites WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL`,
      [req.params.id, req.org!.id],
    );
    if (!rowCount) throw notFound('No pending invitation with that id.');
    await audit(req, 'invite.revoked', { type: 'invite', id: req.params.id });
    res.status(204).end();
  }),
);

/** Accept an invitation as an already-registered user. */
orgs.post(
  '/invites/accept',
  validate(z.object({ token: z.string().min(10) })),
  handler(async (req: AuthedRequest, res) => {
    // Looked up by the secret itself, which is what authorises the join, so
    // this is the one invite query with no org predicate.
    const { rows } = await query(
      `SELECT id, org_id, role, email, expires_at, accepted_at
         FROM invites WHERE token_hash = $1`,
      [hashToken(req.body.token)],
      'orgs.accept_lookup',
    );
    const invite = rows[0];

    if (!invite) throw badRequest('That invitation link is not valid.');
    if (invite.accepted_at) throw conflict('That invitation has already been used.');
    if (new Date(invite.expires_at) < new Date()) throw badRequest('That invitation has expired.');
    if (invite.email.toLowerCase() !== req.user!.email.toLowerCase()) {
      throw forbidden(`That invitation was sent to ${invite.email}.`);
    }

    await transaction(async (db) => {
      await db.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [invite.org_id, req.user!.id, invite.role],
      );
      await db.query(`UPDATE invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [
        invite.id,
        req.user!.id,
      ]);
    });

    res.json({ ok: true, orgId: invite.org_id });
  }),
);

orgs.patch(
  '/members/:id',
  requirePermission('member:manage'),
  validate(z.object({ id: uuid }), 'params'),
  validate(z.object({ role: z.enum(['viewer', 'recruiter', 'admin', 'owner']) })),
  handler(async (req: AuthedRequest, res) => {
    const nextRole = req.body.role as RoleName;

    const { rows } = await query(
      `SELECT m.id, m.role, m.user_id, u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = $1 AND m.org_id = $2`,
      [req.params.id, req.org!.id],
    );
    const member = rows[0];
    if (!member) throw notFound('No such member.');

    if (!canManageRole(req.role!, member.role, nextRole)) {
      throw forbidden(`As ${req.role} you cannot change a ${member.role} to ${nextRole}.`);
    }

    // Demoting the last owner would leave the workspace with nobody able to
    // manage billing or members.
    if (member.role === 'owner' && nextRole !== 'owner') {
      const { rows: owners } = await query(
        `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`,
        [req.org!.id],
      );
      if (owners[0].n <= 1) throw badRequest('A workspace must keep at least one owner.');
    }

    await query(`UPDATE memberships SET role = $1 WHERE id = $2`, [nextRole, member.id]);
    await audit(req, 'member.role_changed', { type: 'membership', id: member.id }, {
      email: member.email,
      from: member.role,
      to: nextRole,
    });

    res.json({ id: member.id, role: nextRole });
  }),
);

orgs.delete(
  '/members/:id',
  requirePermission('member:manage'),
  validate(z.object({ id: uuid }), 'params'),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(
      `SELECT m.id, m.role, m.user_id, u.email FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1 AND m.org_id = $2`,
      [req.params.id, req.org!.id],
    );
    const member = rows[0];
    if (!member) throw notFound('No such member.');

    if (member.role === 'owner') {
      const { rows: owners } = await query(
        `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`,
        [req.org!.id],
      );
      if (owners[0].n <= 1) throw badRequest('A workspace must keep at least one owner.');
    }
    if (!canManageRole(req.role!, member.role, member.role)) {
      throw forbidden(`As ${req.role} you cannot remove a ${member.role}.`);
    }

    await query(`DELETE FROM memberships WHERE id = $1`, [member.id]);
    await audit(req, 'member.removed', { type: 'membership', id: member.id }, {
      email: member.email,
    });
    res.status(204).end();
  }),
);

orgs.patch(
  '/',
  requirePermission('org:update'),
  validate(z.object({ name: z.string().trim().min(2).max(80) })),
  handler(async (req: AuthedRequest, res) => {
    const { rows } = await query(
      `UPDATE orgs SET name = $1 WHERE id = $2 RETURNING id, name, slug`,
      [req.body.name, req.org!.id],
    );
    await audit(req, 'org.updated', { type: 'org', id: req.org!.id }, { name: req.body.name });
    res.json(rows[0]);
  }),
);

/** The security audit trail. Admin-only, newest first. */
orgs.get(
  '/audit',
  requirePermission('member:manage'),
  handler(async (req: AuthedRequest, res) => {
    // audit_log is under row-level security, so it must be read through a
    // tenant-pinned connection. A plain pool query would return zero rows.
    const { rows } = await tquery(
      req.org!.id,
      `SELECT id, actor_email, action, target_type, target_id, meta, created_at
         FROM audit_log WHERE org_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [req.org!.id],
      'orgs.audit_read',
    );
    res.json(rows);
  }),
);
