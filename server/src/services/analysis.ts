import type { GithubUser, GithubRepo } from './github.js';

/**
 * Turns raw GitHub data into the derived profile that the ranker and the
 * evidence explanations both read.
 *
 * Two judgement calls are worth stating, because they change who ranks well:
 *
 *  - Forks are excluded from language share and impact. A fork reflects what
 *    someone cloned, not what they built, and counting them rewards people who
 *    fork popular repositories.
 *  - Stars are damped with log1p. Linear stars would mean one viral repository
 *    outranks a decade of steady, unglamorous work, which is the opposite of
 *    what a recruiter usually wants.
 */

export interface LanguageShare {
  language: string;
  pct: number;
  repos: number;
  stars: number;
}

export interface Signals {
  totalStars: number;
  totalForks: number;
  originalRepos: number;
  forkedRepos: number;
  archivedRepos: number;
  recentPushes: number;
  activeYears: number;
  medianRepoStars: number;
  topRepoStars: number;
  distinctLanguages: number;
  collaborationRatio: number;
  lastActiveAt: string | null;
}

export interface TopRepo {
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  url: string;
  pushedAt: string;
}

export type Seniority = 'Early-career' | 'Mid-level' | 'Senior' | 'Staff+';

export interface Analysis {
  languages: LanguageShare[];
  topics: string[];
  signals: Signals;
  activityScore: number;
  impactScore: number;
  seniority: Seniority;
  topRepos: TopRepo[];
  /** Flattened text fields that feed the generated tsvector column. */
  languagesText: string;
  topicsText: string;
  repoText: string;
}

const DAY = 86_400_000;

export function analyze(user: GithubUser, repos: GithubRepo[]): Analysis {
  const original = repos.filter((r) => !r.fork);
  const live = original.filter((r) => !r.archived);
  const now = Date.now();

  // ---- language share -----------------------------------------------------
  const byLang = new Map<string, { repos: number; stars: number; weight: number }>();
  for (const r of original) {
    if (!r.language) continue;
    const e = byLang.get(r.language) ?? { repos: 0, stars: 0, weight: 0 };
    e.repos += 1;
    e.stars += r.stargazers_count;
    // Recency decay: what someone shipped this year says more about what they
    // can do today than what they shipped eight years ago.
    const ageDays = Math.max(0, (now - new Date(r.pushed_at).getTime()) / DAY);
    const recency = Math.exp(-ageDays / 900); // roughly a 2.5 year half-life
    e.weight += (1 + Math.log1p(r.stargazers_count)) * (0.35 + 0.65 * recency);
    byLang.set(r.language, e);
  }

  const totalWeight = [...byLang.values()].reduce((s, e) => s + e.weight, 0) || 1;
  const languages: LanguageShare[] = [...byLang.entries()]
    .map(([language, e]) => ({
      language,
      pct: Math.round((e.weight / totalWeight) * 1000) / 10,
      repos: e.repos,
      stars: e.stars,
    }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 8);

  // ---- topics -------------------------------------------------------------
  const topicCount = new Map<string, number>();
  for (const r of original) {
    for (const t of r.topics ?? []) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  }
  const topics = [...topicCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([t]) => t);

  // ---- signals ------------------------------------------------------------
  const starCounts = original.map((r) => r.stargazers_count).sort((a, b) => a - b);
  const median = starCounts.length ? starCounts[Math.floor(starCounts.length / 2)] : 0;

  const pushTimes = original
    .map((r) => new Date(r.pushed_at).getTime())
    .filter((t) => Number.isFinite(t));
  const lastActive = pushTimes.length ? Math.max(...pushTimes) : null;

  const accountAgeYears = (now - new Date(user.created_at).getTime()) / (365 * DAY);
  const totalStars = original.reduce((s, r) => s + r.stargazers_count, 0);
  const totalForks = original.reduce((s, r) => s + r.forks_count, 0);

  const signals: Signals = {
    totalStars,
    totalForks,
    originalRepos: original.length,
    forkedRepos: repos.length - original.length,
    archivedRepos: original.filter((r) => r.archived).length,
    recentPushes: live.filter((r) => now - new Date(r.pushed_at).getTime() < 90 * DAY).length,
    activeYears: Math.max(0, Math.round(accountAgeYears * 10) / 10),
    medianRepoStars: median,
    topRepoStars: starCounts.length ? starCounts[starCounts.length - 1] : 0,
    distinctLanguages: byLang.size,
    // How much of their work other people build on, rather than only star.
    collaborationRatio: totalStars > 0 ? Math.round((totalForks / totalStars) * 100) / 100 : 0,
    lastActiveAt: lastActive ? new Date(lastActive).toISOString() : null,
  };

  // ---- scores -------------------------------------------------------------
  // Both are squashed into 0..1 so they blend with retrieval scores without one
  // term's units swamping the others.
  const daysSinceActive = lastActive ? (now - lastActive) / DAY : 3650;
  const recencyTerm = Math.exp(-daysSinceActive / 180); // roughly 6 month half-life
  const cadenceTerm = Math.min(1, signals.recentPushes / 8);
  const breadthTerm = Math.min(1, signals.originalRepos / 20);
  const activityScore =
    Math.round((0.5 * recencyTerm + 0.3 * cadenceTerm + 0.2 * breadthTerm) * 1000) / 1000;

  const starTerm = Math.min(1, Math.log1p(totalStars) / Math.log1p(5000));
  const followerTerm = Math.min(1, Math.log1p(user.followers) / Math.log1p(3000));
  const depthTerm = Math.min(1, Math.log1p(signals.topRepoStars) / Math.log1p(2000));
  const impactScore =
    Math.round((0.45 * starTerm + 0.3 * followerTerm + 0.25 * depthTerm) * 1000) / 1000;

  // ---- seniority ----------------------------------------------------------
  // A transparent band, not a prediction. It combines tenure with evidence of
  // sustained output, and is shown to recruiters as a hint. DevScout never
  // filters on it unless the recruiter explicitly asks for it.
  const seniority: Seniority =
    accountAgeYears >= 8 && impactScore > 0.5
      ? 'Staff+'
      : accountAgeYears >= 5 && (impactScore > 0.3 || signals.originalRepos > 25)
        ? 'Senior'
        : accountAgeYears >= 2.5 || signals.originalRepos > 10
          ? 'Mid-level'
          : 'Early-career';

  const topRepos: TopRepo[] = [...original]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 6)
    .map((r) => ({
      name: r.name,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      url: r.html_url,
      pushedAt: r.pushed_at,
    }));

  // Text used for lexical search. Language names repeat in proportion to their
  // share, so ts_rank naturally weights a primary language above a dabble.
  const languagesText = languages
    .flatMap((l) => new Array(Math.max(1, Math.round(l.pct / 15))).fill(l.language))
    .join(' ');

  const repoText = original
    .slice(0, 40)
    .map((r) =>
      [r.name.replace(/[-_]/g, ' '), r.description ?? '', (r.topics ?? []).join(' ')].join(' '),
    )
    .join(' ')
    .slice(0, 6000);

  return {
    languages,
    topics,
    signals,
    activityScore,
    impactScore,
    seniority,
    topRepos,
    languagesText,
    topicsText: topics.join(' '),
    repoText,
  };
}

/** The document that gets embedded. Order matters: strongest signal first. */
export function embeddingText(user: GithubUser, a: Analysis): string {
  return [
    user.name ?? user.login,
    user.bio ?? '',
    a.languages.map((l) => `${l.language} ${l.pct}%`).join(', '),
    a.topics.join(', '),
    user.company ?? '',
    user.location ?? '',
    a.topRepos.map((r) => `${r.name}: ${r.description ?? ''}`).join('. '),
  ]
    .filter(Boolean)
    .join('\n');
}
