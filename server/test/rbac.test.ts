import { describe, it, expect } from 'vitest';
import { can, permissionsFor, canManageRole, ROLES, ROLE_RANK, PERMISSIONS } from '../src/lib/rbac.js';

/**
 * The permission ladder. These are pure functions, so the tests are cheap and
 * can be exhaustive - which matters, because a permission table is exactly the
 * kind of code that drifts silently when someone adds a role.
 */
describe('role ladder', () => {
  it('grants every lower role a strict subset of the next role permissions', () => {
    const ordered = [...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);

    for (let i = 0; i < ordered.length - 1; i++) {
      const lower = new Set(permissionsFor(ordered[i]));
      const higher = new Set(permissionsFor(ordered[i + 1]));
      for (const p of lower) {
        expect(higher.has(p), `${ordered[i + 1]} should inherit ${p} from ${ordered[i]}`).toBe(true);
      }
      expect(higher.size).toBeGreaterThan(lower.size);
    }
  });

  it('grants nothing to a caller with no role', () => {
    expect(permissionsFor(undefined)).toEqual([]);
    for (const p of PERMISSIONS) expect(can(undefined, p)).toBe(false);
  });

  it('keeps billing and deletion owner-only', () => {
    expect(can('admin', 'billing:manage')).toBe(false);
    expect(can('owner', 'billing:manage')).toBe(true);
    expect(can('admin', 'org:delete')).toBe(false);
    expect(can('owner', 'org:delete')).toBe(true);
  });

  it('keeps viewers read-only', () => {
    expect(can('viewer', 'search:run')).toBe(true);
    expect(can('viewer', 'candidate:view')).toBe(true);
    expect(can('viewer', 'list:write')).toBe(false);
    expect(can('viewer', 'note:write')).toBe(false);
    expect(can('viewer', 'export:csv')).toBe(false);
  });
});

describe('privilege escalation guards', () => {
  it('stops anyone granting a role above their own', () => {
    // The classic escalation: an admin promoting themselves to owner.
    expect(canManageRole('admin', 'recruiter', 'owner')).toBe(false);
    expect(canManageRole('recruiter', 'viewer', 'admin')).toBe(false);
    expect(canManageRole('owner', 'admin', 'owner')).toBe(true);
  });

  it('stops an admin editing another admin', () => {
    expect(canManageRole('admin', 'admin', 'recruiter')).toBe(false);
    // An owner may, because someone has to be able to.
    expect(canManageRole('owner', 'admin', 'viewer')).toBe(true);
  });

  it('lets an admin manage roles below them', () => {
    expect(canManageRole('admin', 'viewer', 'recruiter')).toBe(true);
    expect(canManageRole('admin', 'recruiter', 'viewer')).toBe(true);
  });

  it('never lets a non-admin manage roles at all', () => {
    for (const target of ROLES) {
      expect(canManageRole('recruiter', target, 'viewer')).toBe(false);
      expect(canManageRole('viewer', target, 'viewer')).toBe(false);
    }
  });
});
