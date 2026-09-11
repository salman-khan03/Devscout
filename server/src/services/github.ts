import { env } from '../config/env.js';
import { AppError, upstream, notFound, tooMany } from '../lib/errors.js';
import { githubCalls, githubRateRemaining } from '../lib/metrics.js';
import { log } from '../lib/logger.js';
import { Cache } from '../lib/cache.js';
import { store } from '../lib/redis.js';

const API = 'https://api.github.com';

/**
 * GitHub REST client.
 *
 * The scarce resource here is quota: 60 requests/hour unauthenticated, 5,000
 * with a token, and the Search API is separately capped at 30/minute. Three
 * things protect it:
 *
 *   1. Caching with single-flight, so N concurrent viewers of one profile cost
 *      one request (lib/cache.ts).
 *   2. A shared circuit breaker. When GitHub reports the budget exhausted, the
 *      reset timestamp is written to Redis and every instance stops calling
 *      until then, instead of each discovering the 403 on its own.
 *   3. Retry with backoff on 5xx and secondary rate limits, never on 4xx.
 */

export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  location: string | null;
  company: string | null;
  blog: string | null;
  email: string | null;
  hireable: boolean | null;
  followers: number;
  following: number;
  public_repos: number;
  created_at: string;
}

export interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  fork: boolean;
  archived: boolean;
  pushed_at: string;
  topics?: string[];
}

export interface SearchHit {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
}

const userCache = new Cache<GithubUser>('gh:user', 6 * 60 * 60);
const reposCache = new Cache<GithubRepo[]>('gh:repos', 6 * 60 * 60);
const searchCache = new Cache<SearchHit[]>('gh:search', 15 * 60);

const BREAKER_KEY = 'gh:circuit-open-until';

export const githubConfigured = () => Boolean(env.GITHUB_TOKEN);

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'DevScout/2.0',
  };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function breakerOpen(): Promise<number | null> {
  const until = await store.get(BREAKER_KEY).catch(() => null);
  if (!until) return null;
  const ts = Number(until);
  if (Number.isNaN(ts) || ts <= Date.now()) return null;
  return ts;
}

async function tripBreaker(resetEpochSeconds: number | null): Promise<void> {
  // Default to a 60s cool-off when GitHub does not tell us when to come back.
  const until = resetEpochSeconds ? resetEpochSeconds * 1000 : Date.now() + 60_000;
  const ttl = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  await store.set(BREAKER_KEY, String(until), ttl).catch(() => undefined);
  log().warn({ until: new Date(until).toISOString() }, 'GitHub rate limit hit - circuit opened');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(path: string, endpoint: string, attempt = 0): Promise<T> {
  const openUntil = await breakerOpen();
  if (openUntil) {
    githubCalls.inc({ endpoint, outcome: 'circuit_open' });
    const seconds = Math.ceil((openUntil - Date.now()) / 1000);
    throw tooMany(
      `GitHub's rate limit is exhausted. Ingestion resumes in ${seconds}s.` +
        (githubConfigured() ? '' : ' Setting GITHUB_TOKEN raises the limit from 60 to 5,000 per hour.'),
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Network error or timeout: retry a couple of times, then give up.
    if (attempt < 2) {
      await sleep(2 ** attempt * 500);
      return call<T>(path, endpoint, attempt + 1);
    }
    githubCalls.inc({ endpoint, outcome: 'network_error' });
    throw upstream(`Could not reach GitHub: ${(e as Error).message}`);
  }

  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) githubRateRemaining.set(Number(remaining));

  if (res.ok) {
    githubCalls.inc({ endpoint, outcome: 'ok' });
    return (await res.json()) as T;
  }

  if (res.status === 404) {
    githubCalls.inc({ endpoint, outcome: 'not_found' });
    throw notFound('No such GitHub user.');
  }

  // 403 with no quota left, or 429, means back off for real.
  if ((res.status === 403 && remaining === '0') || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const retryAfter = res.headers.get('retry-after');
    await tripBreaker(
      reset ? Number(reset) : retryAfter ? Math.floor(Date.now() / 1000) + Number(retryAfter) : null,
    );
    githubCalls.inc({ endpoint, outcome: 'rate_limited' });
    throw tooMany('GitHub rate limit reached. Queued work will resume automatically.');
  }

  if (res.status >= 500 && attempt < 2) {
    await sleep(2 ** attempt * 750);
    return call<T>(path, endpoint, attempt + 1);
  }

  githubCalls.inc({ endpoint, outcome: `http_${res.status}` });
  throw upstream(`GitHub responded ${res.status}.`);
}

/** Search users. `q` accepts GitHub qualifiers (language:rust followers:>100). */
export function searchUsers(q: string, perPage = 30, page = 1): Promise<SearchHit[]> {
  return searchCache.wrap(`${q}:${perPage}:${page}`, async () => {
    const data = await call<{ items: SearchHit[] }>(
      `/search/users?q=${encodeURIComponent(q)}&per_page=${Math.min(perPage, 100)}&page=${page}`,
      'search',
    );
    return (data.items ?? []).map((i) => ({
      login: i.login,
      id: i.id,
      avatar_url: i.avatar_url,
      html_url: i.html_url,
    }));
  });
}

export function getUser(login: string): Promise<GithubUser> {
  return userCache.wrap(login.toLowerCase(), () =>
    call<GithubUser>(`/users/${encodeURIComponent(login)}`, 'user'),
  );
}

export function getRepos(login: string): Promise<GithubRepo[]> {
  return reposCache.wrap(login.toLowerCase(), () =>
    call<GithubRepo[]>(
      `/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&type=owner`,
      'repos',
    ),
  );
}

/** Remaining quota, for the ingestion dashboard. */
export async function rateLimitStatus(): Promise<{
  limit: number;
  remaining: number;
  resetAt: string;
  circuitOpenUntil: string | null;
}> {
  const openUntil = await breakerOpen();
  try {
    const data = await call<{ resources: { core: { limit: number; remaining: number; reset: number } } }>(
      '/rate_limit',
      'rate_limit',
    );
    const core = data.resources.core;
    return {
      limit: core.limit,
      remaining: core.remaining,
      resetAt: new Date(core.reset * 1000).toISOString(),
      circuitOpenUntil: openUntil ? new Date(openUntil).toISOString() : null,
    };
  } catch (e) {
    if (e instanceof AppError && e.status === 429) {
      return {
        limit: githubConfigured() ? 5000 : 60,
        remaining: 0,
        resetAt: openUntil ? new Date(openUntil).toISOString() : new Date().toISOString(),
        circuitOpenUntil: openUntil ? new Date(openUntil).toISOString() : null,
      };
    }
    throw e;
  }
}
