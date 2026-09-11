import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import type { GithubUser } from './github.js';
import type { Analysis } from './analysis.js';

/**
 * Recruiter-facing summary and role fit.
 *
 * The hard constraint is that the summary must not assert anything the GitHub
 * data does not support. Two things enforce that:
 *
 *  1. The model is handed a fixed set of computed facts, never free text it
 *     could elaborate on, and is told to describe only those.
 *  2. The output is a short field rendered next to the numbers it came from,
 *     so a recruiter can check it at a glance.
 *
 * With no API key the heuristic path produces a summary from the same facts by
 * template. It is blunter, but it is never wrong, and it means the product is
 * fully functional with zero credentials. `summary_source` records which path
 * produced a row so the UI can label it.
 */

export interface Report {
  summary: string | null;
  roleFit: string | null;
  source: 'llm' | 'heuristic';
}

export async function summarize(user: GithubUser, analysis: Analysis): Promise<Report> {
  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) return heuristic(user, analysis);

  // Only computed facts cross this boundary.
  const facts = {
    login: user.login,
    name: user.name,
    bio: user.bio,
    company: user.company,
    location: user.location,
    followers: user.followers,
    accountAgeYears: analysis.signals.activeYears,
    languages: analysis.languages.map((l) => ({ language: l.language, pct: l.pct, repos: l.repos })),
    topics: analysis.topics.slice(0, 10),
    originalRepos: analysis.signals.originalRepos,
    totalStars: analysis.signals.totalStars,
    recentPushes90d: analysis.signals.recentPushes,
    topRepos: analysis.topRepos.map((r) => ({
      name: r.name,
      stars: r.stars,
      language: r.language,
      description: r.description?.slice(0, 160) ?? null,
    })),
  };

  const system = [
    'You are a technical sourcer summarising a public GitHub profile for a recruiter.',
    'Use ONLY the facts in the JSON you are given. Never infer employment history,',
    'seniority beyond what the data shows, education, or personal characteristics.',
    'If the data is thin, say it is thin.',
    'Return strict JSON with exactly two keys:',
    '  "summary": 2-3 sentences, concrete, naming actual languages and repositories.',
    '  "roleFit": one short line, e.g. "Backend engineer (Go, distributed systems)".',
  ].join(' ');

  try {
    const gemini = Boolean(env.GEMINI_API_KEY);
    const endpoint = gemini
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`
      : 'https://openrouter.ai/api/v1/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (gemini) headers['x-goog-api-key'] = env.GEMINI_API_KEY!;
    else headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
    const payload = gemini ? {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(facts) }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048 },
    } : {
      model: env.LLM_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(facts) },
      ],
    };
    const res = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      log().warn({ status: res.status }, 'LLM summary failed, using heuristic');
      return heuristic(user, analysis);
    }

    // Only the one field path this code reads is described - the provider
    // sends far more, and asserting a full schema would be fiction.
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    };
    const raw = gemini
      ? body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '{}'
      : body.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());

    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const roleFit = typeof parsed.roleFit === 'string' ? parsed.roleFit.trim() : '';
    if (!summary) return heuristic(user, analysis);

    return { summary, roleFit: roleFit || heuristic(user, analysis).roleFit, source: 'llm' };
  } catch (e) {
    log().warn({ err: (e as Error).message }, 'LLM summary errored, using heuristic');
    return heuristic(user, analysis);
  }
}

/** Deterministic fallback. Every clause is traceable to a computed number. */
function heuristic(user: GithubUser, a: Analysis): Report {
  const langs = a.languages.slice(0, 3).map((l) => l.language);
  const primary = langs[0];
  const s = a.signals;
  const who = user.name || user.login;

  const parts: string[] = [];

  if (primary) {
    const share = a.languages[0].pct;
    parts.push(
      `${who} works primarily in ${primary} (${share}% of their public work)` +
        (langs.length > 1 ? `, alongside ${langs.slice(1).join(' and ')}.` : '.'),
    );
  } else {
    parts.push(`${who} has ${s.originalRepos} public repositories with no dominant language.`);
  }

  parts.push(
    `${s.originalRepos} original ${s.originalRepos === 1 ? 'repo' : 'repos'} totalling ` +
      `${s.totalStars.toLocaleString()} stars, over ${s.activeYears} years on GitHub.`,
  );

  parts.push(
    s.recentPushes > 0
      ? `Actively shipping: ${s.recentPushes} ${s.recentPushes === 1 ? 'repo' : 'repos'} pushed in the last 90 days.`
      : 'No public pushes in the last 90 days.',
  );

  const focus = a.topics.length ? ` (${a.topics.slice(0, 2).join(', ')})` : '';
  const roleFit = primary
    ? `${a.seniority} ${primary} engineer${focus}`
    : `${a.seniority} engineer${focus}`;

  return { summary: parts.join(' '), roleFit, source: 'heuristic' };
}
