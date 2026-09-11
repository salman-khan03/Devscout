import { Router } from 'express';
import { handler } from '../lib/errors.js';
import { requireAuth, requireOrg, type AuthedRequest } from '../lib/auth.js';
import { requirePermission } from '../lib/rbac.js';
import { meter } from '../lib/usage.js';
import { rateLimit } from '../lib/ratelimit.js';
import { validate, z, csv, intParam, boolParam } from '../lib/validate.js';
import { search, facets, type SearchFilters } from '../services/ranking.js';
import { trackSearch } from '../services/audit.js';
import { tquery } from '../db/pool.js';

export const searchRoutes = Router();

searchRoutes.use(requireAuth, requireOrg);

/**
 * The filter contract, shared by the search endpoint, the facet endpoint and
 * saved searches. It is defined once here so a saved search can be replayed
 * through exactly the same validation that produced it.
 */
const filterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  languages: csv,
  topics: csv,
  locations: csv,
  seniority: csv,
  minFollowers: intParam(0, 1_000_000),
  minStars: intParam(0, 10_000_000),
  minRepos: intParam(0, 10_000),
  activeWithinDays: intParam(1, 3650),
  hireable: boolParam,
  savedOnly: boolParam,
  excludeSaved: boolParam,
  mode: z.enum(['hybrid', 'vector', 'lexical', 'signal']).optional(),
  sort: z.enum(['relevance', 'stars', 'followers', 'recent']).optional(),
  limit: intParam(1, 100),
  offset: intParam(0, 499),
});

/**
 * GET /api/search
 *
 * Cursor-free, offset-based paging inside a bounded candidate pool. Offset
 * paging is usually the wrong choice, but here the result set is capped at the
 * fusion pool (500) rather than the whole corpus, so the usual objection - that
 * deep offsets force the database to count past millions of rows - does not
 * apply, and it keeps the infinite-scroll client trivially resumable from a URL.
 */
searchRoutes.get(
  '/',
  requirePermission('search:run'),
  rateLimit({ name: 'search', windowSeconds: 60, max: 120, by: 'org' }),
  meter('searches'),
  validate(filterSchema, 'query'),
  handler(async (req: AuthedRequest, res) => {
    const filters = req.query as SearchFilters;
    const result = await search(filters, req.org!.id);

    // Fire-and-forget: analytics must never add latency to a search.
    void trackSearch(req, {
      query: filters.q ?? '',
      filters,
      mode: result.mode,
      resultCount: result.total,
      tookMs: result.tookMs,
    });

    res.json(result);
  }),
);

/**
 * GET /api/search/facets
 *
 * Counts for the filter sidebar, computed over the same filtered pool so the
 * numbers shown next to each option are what selecting it would actually
 * return. Deliberately a separate request: the client refetches facets only
 * when filters change, not on every page of an infinite scroll.
 */
searchRoutes.get(
  '/facets',
  requirePermission('search:run'),
  rateLimit({ name: 'facets', windowSeconds: 60, max: 120, by: 'org' }),
  validate(filterSchema, 'query'),
  handler(async (req: AuthedRequest, res) => {
    res.json(await facets(req.query as SearchFilters, req.org!.id));
  }),
);

/**
 * GET /api/search/suggest?q=
 *
 * Typeahead over handles and names, plus the languages and topics present in
 * the corpus. Trigram-indexed, so it stays fast as the corpus grows.
 */
searchRoutes.get(
  '/suggest',
  requirePermission('search:run'),
  rateLimit({ name: 'suggest', windowSeconds: 60, max: 300, by: 'org' }),
  validate(z.object({ q: z.string().trim().min(1).max(60) }), 'query'),
  handler(async (req: AuthedRequest, res) => {
    const q = (req.query as { q: string }).q.toLowerCase();

    const { rows } = await tquery(
      req.org!.id,
      `
      (SELECT 'developer' AS kind, login AS value, name AS label, avatar_url AS meta
         FROM developers
        WHERE login ILIKE $1 || '%' OR lower(coalesce(name,'')) LIKE '%' || $1 || '%'
        ORDER BY followers DESC LIMIT 5)
      UNION ALL
      -- DISTINCT must be applied to the extracted NAME. Applying it to the
      -- JSONB element instead makes {"language":"Rust","pct":80} and
      -- {"language":"Rust","pct":12} two distinct rows, and the dropdown fills
      -- up with the same language repeated.
      (SELECT 'language', name, name, NULL FROM (
         SELECT DISTINCT l->>'language' AS name
           FROM developers, jsonb_array_elements(languages) l
       ) x WHERE lower(name) LIKE $1 || '%' ORDER BY name LIMIT 4)
      UNION ALL
      (SELECT 'topic', t, t, NULL FROM (
         SELECT DISTINCT jsonb_array_elements_text(topics) AS t FROM developers
       ) y WHERE lower(t) LIKE '%' || $1 || '%' ORDER BY t LIMIT 4)
      UNION ALL
      (SELECT 'saved_search', id::text, name, query
         FROM saved_searches
        WHERE org_id = $2 AND lower(name) LIKE '%' || $1 || '%' LIMIT 3)
      `,
      [q, req.org!.id],
      'search.suggest',
    );

    res.json({ suggestions: rows });
  }),
);

export { filterSchema };
