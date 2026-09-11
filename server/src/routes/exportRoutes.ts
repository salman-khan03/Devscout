import { Router } from 'express';
import { handler, notFound } from '../lib/errors.js';
import { tquery } from '../db/pool.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { requireFeature } from '../lib/usage.js';
import { validate, z, uuid } from '../lib/validate.js';
import { audit, track } from '../services/audit.js';

export const exportRoutes = Router();

exportRoutes.use(requireAuth, requireOrg);

/**
 * RFC 4180 field escaping, plus one thing the RFC does not cover.
 *
 * A value beginning with =, +, - or @ is interpreted as a formula by Excel and
 * Google Sheets. A GitHub bio starting with "=" would therefore execute on
 * open - the CSV injection class of bug. Prefixing a single quote neutralises
 * it while leaving the text readable.
 */
function field(value: unknown): string {
  if (value == null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  'login', 'name', 'profile_url', 'role_fit', 'seniority', 'location', 'company',
  'followers', 'total_stars', 'original_repos', 'pushes_90d', 'top_languages',
  'topics', 'stage', 'rating', 'tags', 'notes', 'saved_at', 'source_query', 'data_source',
];

exportRoutes.get(
  '/csv',
  requirePermission('export:csv'),
  requireFeature('csvExport', 'CSV export'),
  validate(z.object({ listId: uuid.optional() }), 'query'),
  handler(async (req: AuthedRequest, res) => {
    const listId = (req.query as { listId?: string }).listId ?? null;

    const { rows } = await tquery(
      req.org!.id,
      `SELECT d.login, d.name, d.html_url, d.role_fit, d.seniority, d.location, d.company,
              d.followers, d.total_stars, d.original_repos, d.recent_pushes,
              d.languages, d.topics, d.is_synthetic,
              lm.stage, lm.rating, lm.added_at, lm.source_query,
              (SELECT string_agg(t.label, '; ' ORDER BY t.label) FROM tags t
                WHERE t.org_id = lm.org_id AND t.developer_id = d.id) AS tags,
              (SELECT string_agg(n.body, ' | ' ORDER BY n.created_at) FROM notes n
                WHERE n.org_id = lm.org_id AND n.developer_id = d.id) AS notes
         FROM list_members lm
         JOIN developers d ON d.id = lm.developer_id
        WHERE lm.org_id = $1 AND ($2::uuid IS NULL OR lm.list_id = $2)
        ORDER BY lm.added_at DESC`,
      [req.org!.id, listId],
      'export.csv',
    );

    if (!rows.length) throw notFound('There are no saved candidates to export.');

    const lines = [COLUMNS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.login,
          r.name,
          r.html_url,
          r.role_fit,
          r.seniority,
          r.location,
          r.company,
          r.followers,
          r.total_stars,
          r.original_repos,
          r.recent_pushes,
          (r.languages ?? [])
            .map((l: { language: string; pct: number }) => `${l.language} ${l.pct}%`)
            .join('; '),
          (r.topics ?? []).join('; '),
          r.stage,
          r.rating,
          r.tags,
          r.notes,
          r.added_at?.toISOString?.() ?? r.added_at,
          r.source_query,
          // Synthetic rows are labelled in the export too - a spreadsheet that
          // leaves the app must not imply demo data is a real person.
          r.is_synthetic ? 'synthetic-demo' : 'github',
        ]
          .map(field)
          .join(','),
      );
    }

    await audit(req, 'export.csv', undefined, { rows: rows.length, listId });
    void track(req, 'exported', null, { rows: rows.length });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="devscout-${stamp}.csv"`);
    // A BOM makes Excel open UTF-8 names correctly instead of mangling them.
    res.send('﻿' + lines.join('\r\n'));
  }),
);

/** Structured export for anyone wiring DevScout into another system. */
exportRoutes.get(
  '/json',
  requirePermission('export:csv'),
  requireFeature('csvExport', 'Export'),
  validate(z.object({ listId: uuid.optional() }), 'query'),
  handler(async (req: AuthedRequest, res) => {
    const listId = (req.query as { listId?: string }).listId ?? null;

    const { rows } = await tquery(
      req.org!.id,
      `SELECT json_build_object(
                'login', d.login, 'name', d.name, 'profileUrl', d.html_url,
                'roleFit', d.role_fit, 'seniority', d.seniority,
                'location', d.location, 'company', d.company,
                'followers', d.followers, 'totalStars', d.total_stars,
                'languages', d.languages, 'topics', d.topics, 'signals', d.signals,
                'stage', lm.stage, 'rating', lm.rating, 'savedAt', lm.added_at,
                'sourceQuery', lm.source_query, 'evidence', lm.match_evidence,
                'dataSource', CASE WHEN d.is_synthetic THEN 'synthetic-demo' ELSE 'github' END
              ) AS candidate
         FROM list_members lm
         JOIN developers d ON d.id = lm.developer_id
        WHERE lm.org_id = $1 AND ($2::uuid IS NULL OR lm.list_id = $2)
        ORDER BY lm.added_at DESC`,
      [req.org!.id, listId],
      'export.json',
    );

    await audit(req, 'export.csv', undefined, { format: 'json', rows: rows.length });
    res.json({
      exportedAt: new Date().toISOString(),
      workspace: req.org!.slug,
      count: rows.length,
      candidates: rows.map((r) => r.candidate),
    });
  }),
);
