import { describe, it, expect, beforeAll } from 'vitest';
import { localEmbed, cosine, tokenize, DIMENSIONS } from '../src/services/embeddings.js';
import { analyze } from '../src/services/analysis.js';
import { search } from '../src/services/ranking.js';
import { query } from '../src/db/pool.js';
import { prepareSchema } from './setup.js';
import type { GithubUser, GithubRepo } from '../src/services/github.js';

beforeAll(async () => {
  await prepareSchema();
}, 60_000);

describe('local embeddings', () => {
  it('produces unit vectors of the declared dimension', () => {
    const v = localEmbed('rust systems programming with async runtimes');
    expect(v).toHaveLength(DIMENSIONS);
    const magnitude = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    // Unit length is what lets pgvector treat cosine distance as a dot product.
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('is deterministic', () => {
    // The evaluation harness depends on this: a non-deterministic embedder
    // would make scores unreproducible across runs.
    expect(localEmbed('kubernetes operator')).toEqual(localEmbed('kubernetes operator'));
  });

  it('scores related text above unrelated text', () => {
    const query = localEmbed('distributed systems consensus raft replication');
    const near = localEmbed('raft consensus protocol for replicated state machines');
    const far = localEmbed('swiftui animations and mobile interface design');

    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it('handles empty and whitespace input without blowing up', () => {
    expect(localEmbed('')).toHaveLength(DIMENSIONS);
    expect(localEmbed('   ')).toHaveLength(DIMENSIONS);
  });

  it('keeps language names that punctuation would otherwise destroy', () => {
    // Naive tokenisation turns "c++" into "c" and drops "node.js" entirely.
    const tokens = tokenize('I write c++ and c# and node.js and .net');
    expect(tokens).toContain('c++');
    expect(tokens).toContain('c#');
    expect(tokens).toContain('node.js');
  });
});

describe('profile analysis', () => {
  const user = (over: Partial<GithubUser> = {}): GithubUser => ({
    login: 'testuser',
    id: 1,
    name: 'Test User',
    avatar_url: '',
    html_url: '',
    bio: null,
    location: null,
    company: null,
    blog: null,
    email: null,
    hireable: null,
    followers: 100,
    following: 10,
    public_repos: 5,
    created_at: new Date(Date.now() - 5 * 365 * 86_400_000).toISOString(),
    ...over,
  });

  const repo = (over: Partial<GithubRepo> = {}): GithubRepo => ({
    name: 'thing',
    full_name: 'testuser/thing',
    html_url: '',
    description: null,
    language: 'Go',
    stargazers_count: 10,
    forks_count: 1,
    fork: false,
    archived: false,
    pushed_at: new Date().toISOString(),
    topics: [],
    ...over,
  });

  it('excludes forks from language share and impact', () => {
    const result = analyze(user(), [
      repo({ name: 'mine', language: 'Go', stargazers_count: 50 }),
      // A forked Rust repo with huge star count must not make them a Rust dev.
      repo({ name: 'forked', language: 'Rust', stargazers_count: 9000, fork: true }),
    ]);

    expect(result.languages.map((l) => l.language)).toEqual(['Go']);
    expect(result.signals.totalStars).toBe(50);
    expect(result.signals.forkedRepos).toBe(1);
  });

  it('damps stars so one viral repo cannot dominate', () => {
    const viral = analyze(user(), [repo({ stargazers_count: 50_000 })]);
    const steady = analyze(user(), [repo({ stargazers_count: 500 })]);

    expect(viral.impactScore).toBeGreaterThan(steady.impactScore);
    // 100x the stars must not be 100x the score.
    expect(viral.impactScore / steady.impactScore).toBeLessThan(3);
    expect(viral.impactScore).toBeLessThanOrEqual(1);
  });

  it('weights recent work above old work in language share', () => {
    const old = new Date(Date.now() - 6 * 365 * 86_400_000).toISOString();
    const result = analyze(user(), [
      repo({ name: 'legacy', language: 'Perl', pushed_at: old, stargazers_count: 10 }),
      repo({ name: 'current', language: 'Rust', stargazers_count: 10 }),
    ]);

    expect(result.languages[0].language).toBe('Rust');
  });

  it('keeps every score inside 0..1 so the blend stays meaningful', () => {
    const extreme = analyze(user({ followers: 999_999 }), [
      repo({ stargazers_count: 500_000, forks_count: 100_000 }),
    ]);
    expect(extreme.activityScore).toBeGreaterThanOrEqual(0);
    expect(extreme.activityScore).toBeLessThanOrEqual(1);
    expect(extreme.impactScore).toBeGreaterThanOrEqual(0);
    expect(extreme.impactScore).toBeLessThanOrEqual(1);
  });

  it('survives a profile with no repositories', () => {
    const empty = analyze(user({ public_repos: 0 }), []);
    expect(empty.languages).toEqual([]);
    expect(empty.signals.originalRepos).toBe(0);
    expect(empty.seniority).toBeTruthy();
  });
});

describe('hybrid search', () => {
  let hasCorpus = false;

  beforeAll(async () => {
    const { rows } = await query(`SELECT count(*)::int AS n FROM developers`);
    hasCorpus = rows[0].n > 0;
  });

  it('runs every ranking mode and returns scored results', async () => {
    if (!hasCorpus) return;

    for (const mode of ['hybrid', 'lexical', 'vector', 'signal'] as const) {
      const res = await search({ q: 'rust systems programming', mode, limit: 5 }, null);
      expect(res.mode).toBe(mode);
      for (const r of res.results) {
        // The integer-division bug made every lexical score exactly zero while
        // still returning plausible-looking rows.
        expect(r.score).toBeGreaterThan(0);
      }
    }
  });

  it('applies language filters that agree with the underlying data', async () => {
    if (!hasCorpus) return;

    const { rows } = await query(
      `SELECT count(*)::int AS n FROM developers WHERE languages @> '[{"language":"Go"}]'`,
    );
    const expected = rows[0].n;
    if (!expected) return;

    const res = await search({ q: '', languages: ['Go'], limit: 5 }, null);
    // JSONB containment against a bare object silently matches nothing, which
    // showed up as a filter that returned zero rows for a language 104 people
    // actually use.
    expect(res.total).toBe(expected);
  });

  it('pages without repeating results', async () => {
    if (!hasCorpus) return;

    const p1 = await search({ q: 'react accessibility', limit: 5, offset: 0 }, null);
    const p2 = await search({ q: 'react accessibility', limit: 5, offset: 5 }, null);

    const overlap = p1.results.filter((a) => p2.results.some((b) => b.id === a.id));
    expect(overlap).toHaveLength(0);
  });

  it('attaches evidence that can be checked against the profile', async () => {
    if (!hasCorpus) return;

    const res = await search({ q: 'rust', mode: 'hybrid', limit: 5 }, null);
    const withLanguageMatch = res.results.find((r) =>
      r.evidence.matchedTerms.some((t) => t.field === 'language'),
    );
    if (!withLanguageMatch) return;

    // An evidence claim of "language: Rust" must correspond to Rust actually
    // being in their language breakdown, not to a generated assertion.
    const claimed = withLanguageMatch.evidence.matchedTerms
      .filter((t) => t.field === 'language')
      .map((t) => t.term.toLowerCase());
    const actual = withLanguageMatch.languages.map((l) => l.language.toLowerCase());
    for (const term of claimed) expect(actual).toContain(term);
  });

  it('does not repeat the same piece of evidence', async () => {
    if (!hasCorpus) return;

    // "systems" and "programming" both hit the topic "systems-programming".
    const res = await search({ q: 'systems programming rust async', limit: 10 }, null);
    for (const r of res.results) {
      expect(new Set(r.evidence.reasons).size).toBe(r.evidence.reasons.length);
    }
  });

  it('returns an empty result rather than throwing on a nonsense query', async () => {
    const res = await search({ q: 'zzzzqqqxxx nonexistentterm', limit: 5 }, null);
    expect(Array.isArray(res.results)).toBe(true);
  });
});
