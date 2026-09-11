import type { Response, NextFunction } from 'express';
import { forbidden } from './errors.js';
import type { AuthedRequest } from './auth.js';

/**
 * Role-based access control.
 *
 * Roles are a totally ordered ladder, so "can this actor do X" is a numeric
 * comparison against the minimum rank a permission requires. The alternative -
 * a role-to-permission matrix - buys flexibility this product does not need
 * and costs a lookup table nobody can hold in their head.
 *
 * The permission list is exhaustive and the mapping is exported, so the web
 * app renders the same truth the API enforces (it hides what you cannot do;
 * the API still rejects it if you try anyway).
 */
export const ROLE_RANK = {
  viewer: 10,
  recruiter: 20,
  admin: 30,
  owner: 40,
} as const;

export type RoleName = keyof typeof ROLE_RANK;

export const ROLES = Object.keys(ROLE_RANK) as RoleName[];

export type Permission =
  | 'search:run'
  | 'candidate:view'
  | 'candidate:scan'
  | 'list:read'
  | 'list:write'
  | 'note:write'
  | 'tag:write'
  | 'savedSearch:read'
  | 'savedSearch:write'
  | 'export:csv'
  | 'analytics:read'
  | 'ingest:enqueue'
  | 'member:read'
  | 'member:invite'
  | 'member:manage'
  | 'org:update'
  | 'billing:manage'
  | 'org:delete';

/** Minimum role rank required for each permission. */
const REQUIRED: Record<Permission, number> = {
  'search:run': ROLE_RANK.viewer,
  'candidate:view': ROLE_RANK.viewer,
  'list:read': ROLE_RANK.viewer,
  'savedSearch:read': ROLE_RANK.viewer,
  'analytics:read': ROLE_RANK.viewer,
  'member:read': ROLE_RANK.viewer,

  'candidate:scan': ROLE_RANK.recruiter,
  'list:write': ROLE_RANK.recruiter,
  'note:write': ROLE_RANK.recruiter,
  'tag:write': ROLE_RANK.recruiter,
  'savedSearch:write': ROLE_RANK.recruiter,
  'export:csv': ROLE_RANK.recruiter,
  'ingest:enqueue': ROLE_RANK.recruiter,

  'member:invite': ROLE_RANK.admin,
  'member:manage': ROLE_RANK.admin,
  'org:update': ROLE_RANK.admin,

  'billing:manage': ROLE_RANK.owner,
  'org:delete': ROLE_RANK.owner,
};

export const PERMISSIONS = Object.keys(REQUIRED) as Permission[];

export function can(role: RoleName | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= REQUIRED[permission];
}

/** The full permission set for a role - sent to the client to drive the UI. */
export function permissionsFor(role: RoleName | undefined): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}

/** Express guard. Always paired with requireOrg so `req.role` is populated. */
export function requirePermission(permission: Permission) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!can(req.role, permission)) {
      // Names the permission verbatim so the message matches the permission
      // list the client already holds, and says who can grant it.
      const needed = ROLES.find((r) => can(r, permission));
      return next(
        forbidden(
          `This action needs "${permission}", which your role (${req.role ?? 'none'}) does not include.` +
            (needed ? ` Ask an admin to make you a ${needed}.` : ''),
        ),
      );
    }
    next();
  };
}

/**
 * Nobody may grant a role above their own, or edit someone at or above their
 * rank. Without this an admin could promote themselves to owner, which makes
 * the ladder decorative.
 */
export function canManageRole(actor: RoleName, targetCurrent: RoleName | null, targetNext: RoleName): boolean {
  const a = ROLE_RANK[actor];
  if (a < ROLE_RANK.admin) return false;
  if (ROLE_RANK[targetNext] > a) return false;
  if (targetCurrent && ROLE_RANK[targetCurrent] >= a && actor !== 'owner') return false;
  return true;
}
