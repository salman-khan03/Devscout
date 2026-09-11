import { query, toVector } from '../db/pool.js';
import { analyze, embeddingText, type Analysis } from './analysis.js';
import { embed, activeModel } from './embeddings.js';
import { getUser, getRepos, type GithubUser, type GithubRepo } from './github.js';
import { summarize } from './llm.js';
import { log } from '../lib/logger.js';

/**
 * Write path for the shared developer corpus.
 *
 * One function owns every write to `developers`, because the row has
 * invariants that span columns: the flattened *_text fields must agree with
 * the JSONB they were derived from (the generated tsvector reads the former),
 * and `embedding` must agree with `embedding_model`. Spreading those writes
 * across call sites is how an index quietly goes stale.
 */

export interface UpsertResult {
  id: string;
  login: string;
  created: boolean;
}

export async function upsertDeveloper(
  user: GithubUser,
  repos: GithubRepo[],
  opts: { synthetic?: boolean; withSummary?: boolean } = {},
): Promise<UpsertResult> {
  const analysis = analyze(user, repos);

  const report = opts.withSummary === false
    ? { summary: null, roleFit: null, source: 'heuristic' as const }
    : await summarize(user, analysis);

  const vector = await embed(embeddingText(user, analysis));

  // GitHub handles are mutable; the numeric account id is not. If we already
  // know this account under an old login, rename it first. Without this the
  // upsert below conflicts on the github_id unique constraint - which has no
  // DO UPDATE clause - and the ingest fails instead of following the rename.
  if (user.id) {
    await query(
      `UPDATE developers SET login = $1 WHERE github_id = $2 AND login <> $1`,
      [user.login, user.id],
      'corpus.follow_rename',
    );
  }

  const { rows } = await query(
    `
    INSERT INTO developers (
      login, github_id, name, avatar_url, html_url, bio, location, company, blog, email,
      hireable, followers, following, public_repos, github_created_at,
      languages, topics, signals,
      total_stars, total_forks, original_repos, recent_pushes, last_active_at,
      activity_score, impact_score, seniority,
      summary, role_fit, summary_source,
      languages_text, topics_text, repo_text,
      embedding, embedding_model, is_synthetic, fetched_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,
      $16,$17,$18,
      $19,$20,$21,$22,$23,
      $24,$25,$26,
      $27,$28,$29,
      $30,$31,$32,
      $33::vector,$34,$35, now()
    )
    ON CONFLICT (login) DO UPDATE SET
      github_id = EXCLUDED.github_id,
      name = EXCLUDED.name,
      avatar_url = EXCLUDED.avatar_url,
      html_url = EXCLUDED.html_url,
      bio = EXCLUDED.bio,
      location = EXCLUDED.location,
      company = EXCLUDED.company,
      blog = EXCLUDED.blog,
      email = EXCLUDED.email,
      hireable = EXCLUDED.hireable,
      followers = EXCLUDED.followers,
      following = EXCLUDED.following,
      public_repos = EXCLUDED.public_repos,
      github_created_at = EXCLUDED.github_created_at,
      languages = EXCLUDED.languages,
      topics = EXCLUDED.topics,
      signals = EXCLUDED.signals,
      total_stars = EXCLUDED.total_stars,
      total_forks = EXCLUDED.total_forks,
      original_repos = EXCLUDED.original_repos,
      recent_pushes = EXCLUDED.recent_pushes,
      last_active_at = EXCLUDED.last_active_at,
      activity_score = EXCLUDED.activity_score,
      impact_score = EXCLUDED.impact_score,
      seniority = EXCLUDED.seniority,
      -- Keep an existing LLM summary rather than overwriting it with a
      -- heuristic one on a refresh that ran without an API key.
      summary = COALESCE(EXCLUDED.summary, developers.summary),
      role_fit = COALESCE(EXCLUDED.role_fit, developers.role_fit),
      summary_source = CASE
        WHEN EXCLUDED.summary IS NULL THEN developers.summary_source
        ELSE EXCLUDED.summary_source END,
      languages_text = EXCLUDED.languages_text,
      topics_text = EXCLUDED.topics_text,
      repo_text = EXCLUDED.repo_text,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      is_synthetic = EXCLUDED.is_synthetic,
      fetched_at = now()
    RETURNING id, login, (xmax = 0) AS created
    `,
    [
      user.login,
      user.id,
      user.name,
      user.avatar_url,
      user.html_url,
      user.bio,
      user.location,
      user.company,
      user.blog,
      user.email,
      user.hireable,
      user.followers,
      user.following,
      user.public_repos,
      user.created_at,
      JSON.stringify(analysis.languages),
      JSON.stringify(analysis.topics),
      JSON.stringify(analysis.signals),
      analysis.signals.totalStars,
      analysis.signals.totalForks,
      analysis.signals.originalRepos,
      analysis.signals.recentPushes,
      analysis.signals.lastActiveAt,
      analysis.activityScore,
      analysis.impactScore,
      analysis.seniority,
      report.summary,
      report.roleFit,
      report.source,
      analysis.languagesText,
      analysis.topicsText,
      analysis.repoText,
      toVector(vector),
      activeModel(),
      opts.synthetic ?? false,
    ],
    'corpus.upsert_developer',
  );

  const result = rows[0] as UpsertResult;
  await replaceRepos(result.id, repos);
  return result;
}

/**
 * Repos are replaced rather than merged: a repo that disappeared upstream
 * (renamed, deleted, made private) must not linger as evidence we would show a
 * recruiter. One statement per side keeps it a single round trip each.
 */
async function replaceRepos(developerId: string, repos: GithubRepo[]): Promise<void> {
  // Postgres refuses an ON CONFLICT DO UPDATE whose source rows collide on the
  // conflict target ("cannot affect row a second time"), so the batch has to be
  // unique on (developer_id, name) before it is sent. Keeping the first
  // occurrence is right because the caller sorts by pushed_at descending.
  const seen = new Set<string>();
  const keep = repos
    .filter((r) => {
      const key = r.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
  if (!keep.length) {
    await query(`DELETE FROM developer_repos WHERE developer_id = $1`, [developerId]);
    return;
  }

  await query(
    `DELETE FROM developer_repos WHERE developer_id = $1 AND name <> ALL($2::text[])`,
    [developerId, keep.map((r) => r.name)],
    'corpus.prune_repos',
  );

  // unnest() turns the arrays into rows, so 100 repos cost one statement.
  await query(
    `
    INSERT INTO developer_repos (developer_id, name, description, language, stars, forks, topics, is_fork, html_url, pushed_at)
    SELECT $1, t.name, t.description, t.language, t.stars, t.forks, t.topics::jsonb, t.is_fork, t.html_url, t.pushed_at
      FROM unnest(
        $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::text[], $8::bool[], $9::text[], $10::timestamptz[]
      ) AS t(name, description, language, stars, forks, topics, is_fork, html_url, pushed_at)
    ON CONFLICT (developer_id, name) DO UPDATE SET
      description = EXCLUDED.description,
      language = EXCLUDED.language,
      stars = EXCLUDED.stars,
      forks = EXCLUDED.forks,
      topics = EXCLUDED.topics,
      is_fork = EXCLUDED.is_fork,
      html_url = EXCLUDED.html_url,
      pushed_at = EXCLUDED.pushed_at
    `,
    [
      developerId,
      keep.map((r) => r.name),
      keep.map((r) => r.description),
      keep.map((r) => r.language),
      keep.map((r) => r.stargazers_count),
      keep.map((r) => r.forks_count),
      keep.map((r) => JSON.stringify(r.topics ?? [])),
      keep.map((r) => r.fork),
      keep.map((r) => r.html_url),
      keep.map((r) => r.pushed_at),
    ],
    'corpus.upsert_repos',
  );
}

/** Fetch from GitHub and write through. The unit of work for an ingest job. */
export async function ingestLogin(login: string): Promise<UpsertResult> {
  const [user, repos] = await Promise.all([getUser(login), getRepos(login)]);
  const result = await upsertDeveloper(user, repos);
  log().info({ login, created: result.created, repos: repos.length }, 'developer ingested');
  return result;
}

/** Re-embed rows whose vector was produced by a different model. */
export async function reembedStale(limit = 100): Promise<number> {
  const { rows } = await query(
    `SELECT d.id, d.login, d.name, d.bio, d.company, d.location, d.languages, d.topics
       FROM developers d
      WHERE d.embedding IS NULL OR d.embedding_model IS DISTINCT FROM $1
      LIMIT $2`,
    [activeModel(), limit],
    'corpus.find_stale_embeddings',
  );

  for (const row of rows) {
    const text = [
      row.name ?? row.login,
      row.bio ?? '',
      (row.languages ?? [])
        .map((l: { language: string; pct: number }) => `${l.language} ${l.pct}%`)
        .join(', '),
      (row.topics ?? []).join(', '),
      row.company ?? '',
      row.location ?? '',
    ]
      .filter(Boolean)
      .join('\n');

    const vector = await embed(text);
    await query(
      `UPDATE developers SET embedding = $1::vector, embedding_model = $2 WHERE id = $3`,
      [toVector(vector), activeModel(), row.id],
      'corpus.write_embedding',
    );
  }

  return rows.length;
}

/** Full profile for the detail panel, including repos. */
/**
 * A row of `developers`, as read back out of Postgres.
 *
 * The index signature is inherited rather than declared away: `SELECT *`
 * genuinely returns every column including the generated ones, and claiming a
 * closed shape here would be a lie the compiler then enforces. The named
 * fields are the ones the API actually reads, so those at least are checked.
 */
export interface DeveloperRow {
  [column: string]: unknown;
  id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  html_url: string | null;
  bio: string | null;
  location: string | null;
  company: string | null;
  blog: string | null;
  hireable: boolean | null;
  followers: number;
  following: number;
  public_repos: number;
  github_created_at: string | null;
  languages: Array<{ language: string; pct: number; repos: number; stars: number }>;
  topics: string[];
  signals: Record<string, unknown>;
  total_stars: number;
  total_forks: number;
  original_repos: number;
  recent_pushes: number;
  last_active_at: string | null;
  activity_score: number;
  impact_score: number;
  seniority: string | null;
  summary: string | null;
  role_fit: string | null;
  summary_source: string;
  is_synthetic: boolean;
  fetched_at: string | null;
  updated_at: string;
}

/** A non-fork repository belonging to a developer. */
export interface DeveloperRepoRow {
  [column: string]: unknown;
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  is_fork: boolean;
  html_url: string;
  pushed_at: string;
}

export async function getDeveloper(
  login: string,
): Promise<(DeveloperRow & { repos: DeveloperRepoRow[] }) | null> {
  const { rows } = await query<DeveloperRow>(
    `SELECT * FROM developers WHERE lower(login) = lower($1)`,
    [login],
    'corpus.get_developer',
  );
  if (!rows.length) return null;
  const dev = rows[0];

  const { rows: repos } = await query<DeveloperRepoRow>(
    `SELECT name, description, language, stars, forks, topics, is_fork, html_url, pushed_at
       FROM developer_repos
      WHERE developer_id = $1 AND is_fork = false
      ORDER BY stars DESC, pushed_at DESC
      LIMIT 12`,
    [dev.id],
    'corpus.get_repos',
  );

  return { ...dev, repos };
}

export type { Analysis };
