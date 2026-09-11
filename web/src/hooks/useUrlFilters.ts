import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Filters, RankMode, SortMode } from '../lib/types';

/**
 * Filter state lives in the URL, not in React state.
 *
 * This is the single decision that makes the search page behave the way people
 * expect it to:
 *
 *   - The back button steps through filter changes instead of leaving the app.
 *   - Any search can be copied out of the address bar and pasted to a
 *     colleague, and they see exactly the same result set.
 *   - A reload does not silently reset the work someone just set up.
 *   - A saved search and a shared link are the same object, so they cannot
 *     drift apart.
 *
 * The cost is that every filter must survive a string round trip, which is what
 * the parse/serialise pair below exists to guarantee. Defaults are omitted from
 * the URL so a plain query stays readable.
 */

export const DEFAULT_FILTERS: Filters = {
  q: '',
  languages: [],
  topics: [],
  locations: [],
  seniority: [],
  mode: 'hybrid',
  sort: 'relevance',
};

const csv = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const num = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const bool = (v: string | null): boolean | undefined =>
  v === null ? undefined : v === 'true' || v === '1';

export function parseFilters(params: URLSearchParams): Filters {
  return {
    q: params.get('q') ?? '',
    languages: csv(params.get('languages')),
    topics: csv(params.get('topics')),
    locations: csv(params.get('locations')),
    seniority: csv(params.get('seniority')),
    minFollowers: num(params.get('minFollowers')),
    minStars: num(params.get('minStars')),
    minRepos: num(params.get('minRepos')),
    activeWithinDays: num(params.get('activeWithinDays')),
    hireable: bool(params.get('hireable')),
    savedOnly: bool(params.get('savedOnly')),
    excludeSaved: bool(params.get('excludeSaved')),
    mode: (params.get('mode') as RankMode) ?? 'hybrid',
    sort: (params.get('sort') as SortMode) ?? 'relevance',
  };
}

export function serialiseFilters(filters: Partial<Filters>): URLSearchParams {
  const p = new URLSearchParams();
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  };

  put('q', filters.q);
  put('languages', filters.languages);
  put('topics', filters.topics);
  put('locations', filters.locations);
  put('seniority', filters.seniority);
  put('minFollowers', filters.minFollowers);
  put('minStars', filters.minStars);
  put('minRepos', filters.minRepos);
  put('activeWithinDays', filters.activeWithinDays);
  put('hireable', filters.hireable);
  put('savedOnly', filters.savedOnly);
  put('excludeSaved', filters.excludeSaved);
  if (filters.mode && filters.mode !== 'hybrid') put('mode', filters.mode);
  if (filters.sort && filters.sort !== 'relevance') put('sort', filters.sort);

  return p;
}

/** Counts the filters a user has actually applied, for the "clear all" badge. */
export function countActiveFilters(f: Filters): number {
  let n = 0;
  n += f.languages.length ? 1 : 0;
  n += f.topics.length ? 1 : 0;
  n += f.locations.length ? 1 : 0;
  n += f.seniority.length ? 1 : 0;
  n += f.minFollowers !== undefined ? 1 : 0;
  n += f.minStars !== undefined ? 1 : 0;
  n += f.minRepos !== undefined ? 1 : 0;
  n += f.activeWithinDays !== undefined ? 1 : 0;
  n += f.hireable ? 1 : 0;
  n += f.savedOnly || f.excludeSaved ? 1 : 0;
  return n;
}

export function useUrlFilters() {
  const [params, setParams] = useSearchParams();

  // Re-parsed only when the query string actually changes, so the object
  // identity is stable enough to use as a React Query key.
  const filters = useMemo(() => parseFilters(params), [params]);

  const setFilters = useCallback(
    (next: Partial<Filters>, opts: { replace?: boolean } = {}) => {
      const merged = { ...filters, ...next };
      setParams(serialiseFilters(merged), {
        // Typing in the search box should not push a history entry per
        // keystroke; toggling a filter should be undoable with Back.
        replace: opts.replace ?? false,
      });
    },
    [filters, setParams],
  );

  /** Toggles one value inside an array filter (languages, topics, ...). */
  const toggleValue = useCallback(
    (key: 'languages' | 'topics' | 'locations' | 'seniority', value: string) => {
      const current = filters[key];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      setFilters({ [key]: next } as Partial<Filters>);
    },
    [filters, setFilters],
  );

  const clearFilters = useCallback(() => {
    // The query text is what someone is looking for; the filters are how they
    // narrowed it. "Clear filters" should not throw away the search itself.
    setParams(serialiseFilters({ ...DEFAULT_FILTERS, q: filters.q, mode: filters.mode }));
  }, [filters.q, filters.mode, setParams]);

  return {
    filters,
    setFilters,
    toggleValue,
    clearFilters,
    activeCount: countActiveFilters(filters),
  };
}
