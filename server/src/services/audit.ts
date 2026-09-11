import { asTenant } from '../db/pool.js';
import { log } from '../lib/logger.js';
import type { AuthedRequest } from '../lib/auth.js';

/**
 * Two append-only streams, deliberately kept apart because they answer
 * different questions and have different retention needs:
 *
 *   audit_log       Security. Who changed what, and from where. Written for
 *                   membership, role, billing and destructive changes.
 *   activity_events Product analytics. What recruiters did with candidates,
 *                   which is what the funnel and the dashboard are built from.
 *
 * Both fail soft. Losing a metric row is regrettable; failing the user's
 * action because the metric write failed is worse, so a logging error is
 * recorded and swallowed rather than propagated.
 */

export type AuditAction =
  | 'org.created' | 'org.updated' | 'org.deleted'
  | 'member.invited' | 'member.joined' | 'member.role_changed' | 'member.removed'
  | 'invite.revoked'
  | 'billing.checkout_started' | 'billing.portal_opened' | 'billing.subscription_changed'
  | 'list.created' | 'list.deleted'
  | 'export.csv'
  | 'ingest.enqueued';

export async function audit(
  req: AuthedRequest,
  action: AuditAction,
  target?: { type: string; id: string },
  meta: Record<string, unknown> = {},
): Promise<void> {
  const orgId = req.org?.id;
  if (!orgId) return;

  try {
    await asTenant(orgId, (db) =>
      db.query(
        `INSERT INTO audit_log (org_id, actor_id, actor_email, action, target_type, target_id, meta, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          orgId,
          req.user?.id ?? null,
          req.user?.email ?? null,
          action,
          target?.type ?? null,
          target?.id ?? null,
          JSON.stringify(meta),
          req.ip ?? null,
        ],
        'audit.write',
      ),
    );
  } catch (e) {
    log().error({ err: (e as Error).message, action }, 'audit write failed');
  }
}

export type ActivityAction =
  | 'viewed' | 'shortlisted' | 'unshortlisted' | 'staged'
  | 'noted' | 'tagged' | 'compared' | 'exported' | 'searched';

export async function track(
  req: AuthedRequest,
  action: ActivityAction,
  developerId?: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const orgId = req.org?.id;
  if (!orgId) return;

  try {
    await asTenant(orgId, (db) =>
      db.query(
        `INSERT INTO activity_events (org_id, user_id, developer_id, action, meta)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, req.user?.id ?? null, developerId ?? null, action, JSON.stringify(meta)],
        'activity.write',
      ),
    );
  } catch (e) {
    log().error({ err: (e as Error).message, action }, 'activity write failed');
  }
}

/** Records a search for the analytics dashboard and the zero-result report. */
export async function trackSearch(
  req: AuthedRequest,
  input: { query: string; filters: unknown; mode: string; resultCount: number; tookMs: number },
): Promise<void> {
  const orgId = req.org?.id;
  if (!orgId) return;

  try {
    await asTenant(orgId, (db) =>
      db.query(
        `INSERT INTO search_events (org_id, user_id, query, filters, mode, result_count, took_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          orgId,
          req.user?.id ?? null,
          input.query,
          JSON.stringify(input.filters ?? {}),
          input.mode,
          input.resultCount,
          input.tookMs,
        ],
        'search_event.write',
      ),
    );
  } catch (e) {
    log().error({ err: (e as Error).message }, 'search event write failed');
  }
}
