import { query, toVector } from '../db/pool.js';
import { embed, activeModel } from './embeddings.js';
import { searchDuration } from '../lib/metrics.js';
import type { LanguageShare, Signals, Seniority } from './analysis.js';

/**
 * Hybrid retrieval.
 *
 * Three rankers see the same filtered candidate set and disagree usefully:
 *
 *   lexical  Postgres full-text over a weighted tsvector. Precise on exact
 *            tokens - "kubernetes", "rust", a company name - and useless for
 *            a phrasing the profile does not literally contain.
 *   vector   pgvector cosine over a 256-d profile embedding. Handles the
 *            paraphrase ("distributed systems" finding someone who wrote
 *            "consensus protocols") and drifts on rare proper nouns.
 *   signal   A query-independent prior from activity and impact. Breaks ties
 *            between candidates the other two rank equally.
 *
 * They are combined with Reciprocal Rank Fusion rather than a weighted sum of
 * scores. That matters: ts_rank_cd and cosine similarity are on different,
 * unnormalised, query-dependent scales, so summing them lets whichever ranker
 * happens to produce larger numbers for this query silently dominate. RRF uses
 * only each ranker's ordinal rank, which is scale-free and robust. The
 * constant k damps the top: it stops a single ranker's first place from being
 * unbeatable by two other rankers' second places.
 *
 * src/eval measures this against each ranker alone on a labelled query set.
 */

/** RRF damping constant. 60 is the value from the original Cormack et al. paper. */
const RRF_K = 60;

/**
 * How many candidates each ranker contributes before fusion. Fused scores are
 * not a stable total order over the whole corpus - they are only meaningful
 * within the pool the rankers actually returned - so pagination is bounded to
 * this pool rather than pretending to offset into millions of rows.
 */
const POOL = 500;

export type RankMode = 'hybrid' | 'vector' | 'lexical' | 'signal';
export type SortMode = 'relevance' | 'stars' | 'followers' | 'recent';

export interface SearchFilters {
  q?: string;
  languages?: string[];
  topics?: string[];
  locations?: string[];
  seniority?: string[];
  minFollowers?: number;
  minStars?: number;
  minRepos?: number;
  activeWithinDays?: number;
  hireable?: boolean;
  /** Restrict to / exclude developers already saved by the requesting org. */
  savedOnly?: boolean;
  excludeSaved?: boolean;
  mode?: RankMode;
  sort?: SortMode;
  limit?: number;
  offset?: number;
}

export interface Evidence {
  /** Query terms that literally appear in this profile, and where. */
  matchedTerms: Array<{ term: string; field: 'language' | 'topic' | 'bio' | 'repo' | 'name' }>;
  /** Human-readable reasons, strongest first. */
  reasons: string[];
  /** Per-ranker contribution to the fused score, for the explain panel. */
  contributions: Array<{ ranker: RankMode; rank: number | null; score: number; weight: number }>;
}

export interface RankedDeveloper {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  bio: string | null;
  location: string | null;
  company: string | null;
  followers: number;
  publicRepos: number;
  totalStars: number;
  originalRepos: number;
  recentPushes: number;
  languages: LanguageShare[];
  topics: string[];
  signals: Signals;
  seniority: Seniority | null;
  summary: string | null;
  roleFit: string | null;
  summarySource: string;
  isSynthetic: boolean;
  lastActiveAt: string | null;
  updatedAt: string;
  score: number;
  evidence: Evidence;
}

export interface SearchResult {
  results: RankedDeveloper[];
  total: number;
  tookMs: number;
  mode: RankMode;
  hasMore: boolean;
  /** True when the corpus has no embeddings for the active model yet. */
  vectorAvailable: boolean;
}

/**
 * Fusion weights, chosen by sweeping them against the labelled query set in
 * src/eval and keeping the best nDCG@10.
 *
 * The prior's weight is the interesting one. At 0.45 it actively hurt - it
 * pulled active-but-irrelevant developers into the top ten and hybrid scored
 * below vector-only. At 0 the top-ranked result got noticeably less reliable
 * (MRR 0.885 vs 0.951). A small weight is the sweet spot: enough to break ties
 * between candidates the query-aware rankers rate equally, not enough to
 * overrule them.
 *
 * Caveat worth stating: with 18 labelled queries there is no held-out split,
 * so these are a well-grounded default rather than a proven optimum. Re-run
 * `npm run eval` after changing them.
 */
const WEIGHTS: Record<Exclude<RankMode, 'hybrid'>, number> = {
  lexical: 1.0,
  vector: 0.85,
  signal: 0.1,
};

/**
 * Renders a weight as an unambiguous float literal.
 *
 * A weight of exactly 1 stringifies to "1", and `1 / (60 + rank)` in Postgres
 * is INTEGER division, which truncates every lexical contribution to zero. The
 * bug is invisible in the default blend - the other two weights are fractional,
 * so hybrid results still look sensible - and only shows up as an all-zero
 * score in lexical-only mode. Force float8 so the arithmetic cannot degrade.
 */
const f8 = (n: number) => `${n.toFixed(6)}::float8`;

interface Bound {
  sql: string;
  params: unknown[];
}

/** Builds the shared WHERE clause. Every value is bound, never interpolated. */
function buildFilters(f: SearchFilters, orgId: string | null, start: number): Bound {
  const where: string[] = ['TRUE'];
  const params: unknown[] = [];
  let i = start;

  if (f.languages?.length) {
    // Each element is a single-element ARRAY, not a bare object. JSONB
    // containment only lets an array contain a primitive as a special case, so
    // `'[{"language":"Go"}]' @> '{"language":"Go"}'` is false while
    // `'[{"language":"Go"}]' @> '[{"language":"Go"}]'` is true. ANY over the
    // list gives OR semantics across the selected languages, and each
    // comparison is still answerable from the jsonb_path_ops GIN index.
    params.push(f.languages.map((l) => JSON.stringify([{ language: l }])));
    where.push(`d.languages @> ANY($${++i}::jsonb[])`);
  }
  if (f.topics?.length) {
    params.push(JSON.stringify(f.topics));
    where.push(`d.topics ?| ARRAY(SELECT jsonb_array_elements_text($${++i}::jsonb))`);
  }
  if (f.locations?.length) {
    params.push(f.locations.map((l) => l.toLowerCase()));
    where.push(`EXISTS (SELECT 1 FROM unnest($${++i}::text[]) loc WHERE lower(d.location) LIKE '%' || loc || '%')`);
  }
  if (f.seniority?.length) {
    params.push(f.seniority);
    where.push(`d.seniority = ANY($${++i}::text[])`);
  }
  if (f.minFollowers != null) {
    params.push(f.minFollowers);
    where.push(`d.followers >= $${++i}`);
  }
  if (f.minStars != null) {
    params.push(f.minStars);
    where.push(`d.total_stars >= $${++i}`);
  }
  if (f.minRepos != null) {
    params.push(f.minRepos);
    where.push(`d.original_repos >= $${++i}`);
  }
  if (f.activeWithinDays != null) {
    params.push(f.activeWithinDays);
    where.push(`d.last_active_at >= now() - make_interval(days => $${++i}::int)`);
  }
  if (f.hireable === true) {
    where.push(`d.hireable IS TRUE`);
  }

  // Saved-state filters cross the tenant boundary in the safe direction: they
  // read this org's list_members, never another's. The subquery is bound to
  // the caller's org id.
  if (orgId && (f.savedOnly || f.excludeSaved)) {
    params.push(orgId);
    const clause = `EXISTS (SELECT 1 FROM list_members lm WHERE lm.developer_id = d.id AND lm.org_id = $${++i})`;
    where.push(f.savedOnly ? clause : `NOT ${clause}`);
  }

  return { sql: where.join(' AND '), params };
}

export async function search(
  filters: SearchFilters,
  orgId: string | null,
): Promise<SearchResult> {
  const mode: RankMode = filters.mode ?? 'hybrid';
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const offset = Math.min(Math.max(filters.offset ?? 0, 0), POOL - 1);
  const q = (filters.q ?? '').trim();
  const stop = searchDuration.startTimer({ mode });
  const started = Date.now();

  // $1 is the query text, $2 the query vector, $3 the embedding model.
  const wantsVector = Boolean(q) && (mode === 'hybrid' || mode === 'vector');
  const vector = wantsVector ? toVector(await embed(q)) : null;

  const params: unknown[] = [q, vector, activeModel()];
  const f = buildFilters(filters, orgId, params.length);
  params.push(...f.params);

  const useLexical = Boolean(q) && (mode === 'hybrid' || mode === 'lexical');
  const useVector = wantsVector;

  // With no query text there is nothing to rank against, so the signal prior
  // becomes the whole ordering - which is the right behaviour for "show me
  // everyone in Berlin who writes Go".
  const useSignal = mode === 'hybrid' || mode === 'signal' || !q;

  // The prior is confined to retrieved candidates only when it is playing its
  // tie-breaking role inside a fused query. In signal-only mode it IS the
  // ranker, so confining it to the other rankers' output would return nothing.
  const confineSignal = Boolean(q) && mode === 'hybrid';

  const explicitSort = filters.sort && filters.sort !== 'relevance' ? filters.sort : null;
  const sortSql = explicitSort
    ? {
        stars: 'd.total_stars DESC',
        followers: 'd.followers DESC',
        recent: 'd.last_active_at DESC NULLS LAST',
      }[explicitSort]
    : 'fused.score DESC';

  const sql = `
    WITH pool AS (
      SELECT d.id FROM developers d WHERE ${f.sql}
    ),
    lex AS (
      SELECT d.id,
             ts_rank_cd(d.search_document, tsq, 32) AS score,
             row_number() OVER (ORDER BY ts_rank_cd(d.search_document, tsq, 32) DESC, d.total_stars DESC) AS rank
        FROM developers d
        JOIN pool p ON p.id = d.id
        CROSS JOIN LATERAL websearch_to_tsquery('english', $1) AS tsq
       WHERE ${useLexical ? 'd.search_document @@ tsq' : 'FALSE'}
       ORDER BY score DESC
       LIMIT ${POOL}
    ),
    vec AS (
      SELECT d.id,
             1 - (d.embedding <=> $2::vector) AS score,
             row_number() OVER (ORDER BY d.embedding <=> $2::vector) AS rank
        FROM developers d
        JOIN pool p ON p.id = d.id
       -- $3 stays referenced even when this ranker is switched off: a bind
       -- parameter that appears in no branch of the assembled SQL makes
       -- Postgres reject the statement for supplying too many parameters.
       WHERE ${useVector ? 'TRUE' : 'FALSE'}
         AND d.embedding IS NOT NULL
         AND d.embedding_model = $3
       ORDER BY d.embedding <=> $2::vector
       LIMIT ${POOL}
    ),
    -- Candidates the query-aware rankers actually found.
    retrieved AS (
      SELECT id FROM lex
      UNION
      SELECT id FROM vec
    ),
    /*
     * The signal prior RE-RANKS, it does not RETRIEVE.
     *
     * Letting it contribute its own candidates measurably hurt: an active,
     * high-impact developer who has nothing to do with the query would be
     * injected into the fused list on the strength of their activity alone.
     * The evaluation harness caught this - hybrid scored below vector-only
     * until the prior was confined to candidates the other rankers had already
     * surfaced. With no query text there is nothing to confine it to, so it
     * ranks the whole filtered pool, which is the correct behaviour for a pure
     * filter search like "everyone in Berlin who writes Go".
     */
    sig AS (
      SELECT d.id,
             (0.6 * d.activity_score + 0.4 * d.impact_score) AS score,
             row_number() OVER (ORDER BY (0.6 * d.activity_score + 0.4 * d.impact_score) DESC) AS rank
        FROM developers d
        JOIN pool p ON p.id = d.id
        ${confineSignal ? 'JOIN retrieved r ON r.id = d.id' : ''}
       WHERE ${useSignal ? 'TRUE' : 'FALSE'}
       ORDER BY score DESC
       LIMIT ${POOL}
    ),
    -- The union of every id any ranker surfaced. Collecting the ids first and
    -- then LEFT JOINing each ranker avoids chained FULL OUTER JOINs, which
    -- Postgres rejects once the join condition stops being a plain column
    -- equality (it has no merge- or hash-joinable plan for COALESCE).
    ids AS (
      SELECT id FROM lex
      UNION SELECT id FROM vec
      UNION SELECT id FROM sig
    ),
    fused AS (
      SELECT
        i.id,
        -- Reciprocal Rank Fusion over whichever rankers produced this row.
        COALESCE(${f8(WEIGHTS.lexical)} / (${RRF_K} + l.rank), 0) +
        COALESCE(${f8(WEIGHTS.vector)}  / (${RRF_K} + v.rank), 0) +
        COALESCE(${f8(WEIGHTS.signal)}  / (${RRF_K} + s.rank), 0) AS score,
        l.rank AS lex_rank, l.score AS lex_score,
        v.rank AS vec_rank, v.score AS vec_score,
        s.rank AS sig_rank, s.score AS sig_score
      FROM ids i
      LEFT JOIN lex l ON l.id = i.id
      LEFT JOIN vec v ON v.id = i.id
      LEFT JOIN sig s ON s.id = i.id
    ),
    counted AS (SELECT count(*)::int AS total FROM fused)
    SELECT d.id, d.login, d.name, d.avatar_url, d.html_url, d.bio, d.location, d.company,
           d.followers, d.public_repos, d.total_stars, d.original_repos, d.recent_pushes,
           d.languages, d.topics, d.signals, d.seniority, d.summary, d.role_fit,
           d.summary_source, d.is_synthetic, d.last_active_at, d.updated_at,
           fused.score, fused.lex_rank, fused.lex_score, fused.vec_rank, fused.vec_score,
           fused.sig_rank, fused.sig_score,
           counted.total,
           -- A short snippet of the bio with the matched terms marked, so the
           -- UI can show the literal evidence instead of asserting a match.
           CASE WHEN $1 <> '' AND d.bio IS NOT NULL
                THEN ts_headline('english', d.bio, websearch_to_tsquery('english', $1),
                                 'StartSel=<<,StopSel=>>,MaxWords=28,MinWords=8,MaxFragments=1')
                ELSE NULL END AS bio_highlight
      FROM fused
      JOIN developers d ON d.id = fused.id
      CROSS JOIN counted
     ORDER BY ${sortSql}, d.total_stars DESC, d.id
     LIMIT ${limit} OFFSET ${offset}
  `;

  const { rows } = await query(sql, params, `search.${mode}`);
  stop();

  const total = rows[0]?.total ?? 0;
  const queryTokens = tokensOf(q);

  return {
    results: rows.map((r) => shape(r, queryTokens)),
    total,
    tookMs: Date.now() - started,
    mode,
    hasMore: offset + rows.length < Math.min(total, POOL),
    vectorAvailable: useVector,
  };
}

function tokensOf(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 1);
}

/**
 * Builds the evidence for one row. Everything here is derived from data the
 * recruiter can verify on the profile itself - matched language, matched
 * topic, a quoted bio fragment - rather than a generated assertion about the
 * person. That is the difference between an explanation and a guess.
 */
function buildEvidence(row: any, queryTokens: string[]): Evidence {
  const matchedTerms: Evidence['matchedTerms'] = [];
  const reasons: string[] = [];

  const languages: LanguageShare[] = row.languages ?? [];
  const topics: string[] = row.topics ?? [];

  // Several query tokens can point at the same piece of evidence ("systems"
  // and "programming" both hit the topic "systems-programming"). Showing that
  // twice makes the panel look broken, so evidence is keyed by what it proves,
  // not by which token found it.
  const claimed = new Set<string>();
  const claim = (key: string) => {
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  };

  for (const token of queryTokens) {
    const lang = languages.find((l) => l.language.toLowerCase() === token);
    if (lang) {
      if (claim(`language:${lang.language}`)) {
        matchedTerms.push({ term: lang.language, field: 'language' });
        reasons.push(
          `${lang.pct}% of their public work is ${lang.language} across ${lang.repos} ${
            lang.repos === 1 ? 'repo' : 'repos'
          }`,
        );
      }
      continue;
    }
    const topic = topics.find((t) => t.toLowerCase() === token || t.toLowerCase().includes(token));
    if (topic) {
      if (claim(`topic:${topic}`)) {
        matchedTerms.push({ term: topic, field: 'topic' });
        reasons.push(`Tags repositories with "${topic}"`);
      }
      continue;
    }
    if (row.bio && row.bio.toLowerCase().includes(token) && claim(`bio:${token}`)) {
      matchedTerms.push({ term: token, field: 'bio' });
    }
  }

  // Quote the bio rather than paraphrasing it.
  if (row.bio_highlight && /<</.test(row.bio_highlight)) {
    reasons.push(`Bio mentions ${row.bio_highlight.replace(/<</g, '"').replace(/>>/g, '"')}`);
  }

  if (row.sig_rank && row.recent_pushes > 0) {
    reasons.push(
      `Pushed to ${row.recent_pushes} ${row.recent_pushes === 1 ? 'repo' : 'repos'} in the last 90 days`,
    );
  }
  if (row.total_stars > 50) {
    reasons.push(`${row.total_stars.toLocaleString()} stars across ${row.original_repos} original repos`);
  }

  const contributions: Evidence['contributions'] = [
    {
      ranker: 'lexical' as const,
      rank: row.lex_rank ?? null,
      score: Number(row.lex_score ?? 0),
      weight: WEIGHTS.lexical,
    },
    {
      ranker: 'vector' as const,
      rank: row.vec_rank ?? null,
      score: Number(row.vec_score ?? 0),
      weight: WEIGHTS.vector,
    },
    {
      ranker: 'signal' as const,
      rank: row.sig_rank ?? null,
      score: Number(row.sig_score ?? 0),
      weight: WEIGHTS.signal,
    },
  ].filter((c) => c.rank !== null);

  return { matchedTerms, reasons: reasons.slice(0, 5), contributions };
}

function shape(row: any, queryTokens: string[]): RankedDeveloper {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    htmlUrl: row.html_url,
    bio: row.bio,
    location: row.location,
    company: row.company,
    followers: row.followers,
    publicRepos: row.public_repos,
    totalStars: row.total_stars,
    originalRepos: row.original_repos,
    recentPushes: row.recent_pushes,
    languages: row.languages ?? [],
    topics: row.topics ?? [],
    signals: row.signals ?? {},
    seniority: row.seniority,
    summary: row.summary,
    roleFit: row.role_fit,
    summarySource: row.summary_source,
    isSynthetic: row.is_synthetic,
    lastActiveAt: row.last_active_at,
    updatedAt: row.updated_at,
    score: Math.round(Number(row.score) * 100000) / 100000,
    evidence: buildEvidence(row, queryTokens),
  };
}

/** Distinct facet values for the filter sidebar, respecting current filters. */
export async function facets(filters: SearchFilters, orgId: string | null) {
  const params: unknown[] = [];
  const f = buildFilters(filters, orgId, 0);
  params.push(...f.params);

  const { rows } = await query(
    `
    WITH pool AS (SELECT d.* FROM developers d WHERE ${f.sql})
    SELECT
      (SELECT json_agg(x) FROM (
         SELECT l->>'language' AS value, count(*)::int AS count
           FROM pool, jsonb_array_elements(pool.languages) l
          GROUP BY 1 ORDER BY 2 DESC LIMIT 20
       ) x) AS languages,
      (SELECT json_agg(x) FROM (
         SELECT t AS value, count(*)::int AS count
           FROM pool, jsonb_array_elements_text(pool.topics) t
          GROUP BY 1 ORDER BY 2 DESC LIMIT 20
       ) x) AS topics,
      (SELECT json_agg(x) FROM (
         SELECT seniority AS value, count(*)::int AS count
           FROM pool WHERE seniority IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC
       ) x) AS seniority,
      (SELECT count(*)::int FROM pool) AS total
    `,
    params,
    'search.facets',
  );

  const r = rows[0];
  return {
    languages: r.languages ?? [],
    topics: r.topics ?? [],
    seniority: r.seniority ?? [],
    total: r.total ?? 0,
  };
}
