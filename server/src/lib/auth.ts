import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { unauthorized, forbidden, AppError } from './errors.js';
import { enrichContext } from './logger.js';
import type { RoleName } from './rbac.js';

const COOKIE = 'devscout_session';
const ORG_COOKIE = 'devscout_org';
/** Cost 12 is ~250ms on commodity hardware - slow enough to matter, fast
 *  enough that a login does not tie up the event loop noticeably. */
const BCRYPT_ROUNDS = 12;

export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_ROUNDS);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** Invite tokens are random secrets; only their hash is ever stored. */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

export interface ActiveOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  subscription_status: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  seats: number;
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
  org?: ActiveOrg;
  role?: RoleName;
  /** Every org the user belongs to, for the workspace switcher. */
  memberships?: Array<{ orgId: string; slug: string; name: string; role: RoleName; plan: string }>;
}

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: '7d', issuer: 'devscout' });
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true, // unreadable from JS, so an XSS cannot exfiltrate the session
    secure: env.isProd,
    // Lax blocks the cross-site POST shape of CSRF while keeping normal
    // top-level navigation back into the app signed in.
    sameSite: env.isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function setOrgCookie(res: Response, orgId: string): void {
  res.cookie(ORG_COOKIE, orgId, {
    httpOnly: false, // the web app reads this to preselect the workspace
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
  res.clearCookie(ORG_COOKIE, { path: '/' });
}

function readToken(req: Request): string | undefined {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);
  return req.cookies?.[COOKIE];
}

/**
 * Resolves the session and, when the user belongs to an org, the active tenant.
 *
 * Active org selection order: explicit `x-devscout-org` header (the web app
 * sends it so a second browser tab can be in a different workspace), then the
 * org cookie, then the oldest membership. A requested org the user is not a
 * member of is a 403 - never a silent fallback to one they can see, which
 * would quietly show them the wrong workspace's data.
 */
export async function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized();

    let payload: { sub: string };
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { issuer: 'devscout' }) as { sub: string };
    } catch {
      throw unauthorized('Your session expired. Sign in again.');
    }

    // One round trip for the user and every membership they hold.
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.avatar_url,
              m.role,
              o.id   AS org_id, o.name AS org_name, o.slug, o.plan,
              o.subscription_status, o.current_period_end, o.cancel_at_period_end, o.seats,
              m.created_at AS joined_at
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id
         LEFT JOIN orgs o        ON o.id = m.org_id
        WHERE u.id = $1
        ORDER BY m.created_at ASC`,
      [payload.sub],
      'auth.load_session',
    );

    if (!rows.length) throw unauthorized('Your session is no longer valid.');
    const first = rows[0];

    req.user = {
      id: first.id,
      email: first.email,
      name: first.name,
      avatar_url: first.avatar_url,
    };

    const withOrg = rows.filter((r) => r.org_id);
    req.memberships = withOrg.map((r) => ({
      orgId: r.org_id,
      slug: r.slug,
      name: r.org_name,
      role: r.role as RoleName,
      plan: r.plan,
    }));

    const requested = (req.headers['x-devscout-org'] as string) || req.cookies?.[ORG_COOKIE];
    let active = withOrg[0];

    if (requested) {
      const match = withOrg.find((r) => r.org_id === requested || r.slug === requested);
      if (!match && withOrg.length) {
        throw forbidden('You are not a member of that workspace.');
      }
      if (match) active = match;
    }

    if (active) {
      req.org = {
        id: active.org_id,
        name: active.org_name,
        slug: active.slug,
        plan: active.plan,
        subscription_status: active.subscription_status,
        current_period_end: active.current_period_end,
        cancel_at_period_end: active.cancel_at_period_end,
        seats: active.seats,
      };
      req.role = active.role as RoleName;
    }

    enrichContext({ userId: req.user.id, orgId: req.org?.id });
    next();
  } catch (e) {
    next(e instanceof AppError ? e : unauthorized());
  }
}

/** Routes that operate on tenant data need a resolved workspace. */
export function requireOrg(req: AuthedRequest, _res: Response, next: NextFunction) {
  if (!req.org || !req.role) {
    return next(new AppError(409, 'Create or join a workspace first.', 'no_workspace'));
  }
  next();
}
