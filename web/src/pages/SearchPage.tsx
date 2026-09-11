import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { useAnnouncer, useDebounced, useHotkeys, useListNavigation, useMediaQuery } from '../hooks';
import { cn, compactNumber } from '../lib/format';
import { FilterPanel } from '../components/FilterPanel';
import { ResultList } from '../components/ResultList';
import { SaveToPipeline } from '../components/SaveToPipeline';
import { SavedSearchBar } from '../components/SavedSearchBar';
import { CompareTray } from '../components/CompareTray';
import { CandidateDrawer } from '../components/CandidateDrawer';
import { Badge, ErrorNotice, useToast } from '../components/ui';
import type { Candidate, Filters, SaveableCandidate } from '../lib/types';

const PAGE_SIZE = 25;

/**
 * The search experience.
 *
 * Composition of the pieces that make this feel like a tool rather than a
 * form: URL-owned filter state, a cursor-free infinite query, optimistic
 * saving, a virtualised list, and keyboard navigation over the results.
 */
export function SearchPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const { filters, setFilters, toggleValue, clearFilters, activeCount } = useUrlFilters();
  const { message, announce } = useAnnouncer();
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [queryDraft, setQueryDraft] = useState(filters.q);
  const [openLogin, setOpenLogin] = useState<string | null>(null);
  const [saveTarget, setSaveTarget] = useState<SaveableCandidate | null>(null);
  const [compare, setCompare] = useState<Candidate[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Typing should not fire a request per keystroke, and an out-of-order reply
  // must not overwrite newer results. Debouncing the query text solves both -
  // React Query keys the newest request and discards stale ones.
  const debouncedQuery = useDebounced(queryDraft, 320);

  // The URL stays the source of truth, updated once typing settles. `replace`
  // keeps the back button stepping through real filter changes rather than
  // every intermediate keystroke.
  useEffect(() => {
    if (debouncedQuery !== filters.q) setFilters({ q: debouncedQuery }, { replace: true });
  }, [debouncedQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // A saved search or a pasted link changes the URL from outside; mirror it in.
  useEffect(() => {
    setQueryDraft(filters.q);
  }, [filters.q]);

  const effectiveFilters: Filters = useMemo(
    () => ({ ...filters, q: debouncedQuery }),
    [filters, debouncedQuery],
  );

  /* -------------------------------------------------------------- results */

  const search = useInfiniteQuery({
    queryKey: ['search', effectiveFilters],
    queryFn: ({ pageParam = 0 }) => api.search(effectiveFilters, pageParam as number, PAGE_SIZE),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.length * PAGE_SIZE : undefined,
    // Results are stable for a minute, so navigating to a profile and back is
    // instant instead of refetching the whole list.
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  const candidates = useMemo(
    () => search.data?.pages.flatMap((p) => p.results) ?? [],
    [search.data],
  );

  const total = search.data?.pages[0]?.total ?? 0;
  const tookMs = search.data?.pages[0]?.tookMs ?? 0;

  // Facets are refetched only when filters change, not per page of scrolling.
  const facets = useQuery({
    queryKey: ['facets', effectiveFilters],
    queryFn: () => api.facets(effectiveFilters),
    staleTime: 60_000,
  });

  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists, staleTime: 120_000 });

  /** Which candidates this workspace has already saved, for the bookmark state. */
  const savedIds = useQuery({
    queryKey: ['saved-ids'],
    queryFn: async () => {
      const res = await api.search({ savedOnly: true, mode: 'signal' }, 0, 100);
      return new Set(res.results.map((r) => r.id));
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!search.isFetching && search.data) {
      announce(
        total === 0
          ? 'No candidates match those filters.'
          : `${total} candidates found in ${tookMs} milliseconds.`,
      );
    }
  }, [total, tookMs, search.isFetching, search.data, announce]);

  /* ------------------------------------------------------------ mutations */

  /**
   * Saving is optimistic: the bookmark fills in immediately and rolls back if
   * the request fails. A recruiter working through a list of 40 people should
   * never wait on a round trip to see that a click registered.
   */
  const saveMutation = useMutation({
    mutationFn: ({ listId, candidate }: { listId: string; candidate: SaveableCandidate }) =>
      api.addToList(listId, {
        developerId: candidate.id,
        sourceQuery: effectiveFilters.q || undefined,
        // The evidence at the moment of saving is stored with the membership,
        // so the team can still see why this person was worth saving later.
        evidence: candidate.evidence,
      }),

    onMutate: async ({ candidate }) => {
      await qc.cancelQueries({ queryKey: ['saved-ids'] });
      const previous = qc.getQueryData<Set<string>>(['saved-ids']);
      qc.setQueryData<Set<string>>(['saved-ids'], (old) => {
        const next = new Set(old ?? []);
        next.add(candidate.id);
        return next;
      });
      return { previous };
    },

    onError: (error, { candidate }, context) => {
      // Put the UI back exactly as it was, then explain why.
      if (context?.previous) qc.setQueryData(['saved-ids'], context.previous);

      if (error instanceof ApiError && error.isPlanLimit) {
        toast(error.message, {
          tone: 'error',
          action: { label: 'See plans', onClick: () => navigate('/pricing') },
        });
        return;
      }
      toast(error instanceof Error ? error.message : `Could not save ${candidate.login}`, {
        tone: 'error',
      });
    },

    onSuccess: (_data, { candidate }) => {
      announce(`${candidate.login} saved.`);
      toast(`${candidate.login} saved`, { tone: 'success' });
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['saved-ids'] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
  });

  const handleSave = useCallback(
    (candidate: SaveableCandidate) => {
      const available = lists.data ?? [];
      // One pipeline: no decision to make, so do not interrupt with a dialog.
      if (available.length === 1) {
        saveMutation.mutate({ listId: available[0].id, candidate });
        return;
      }
      setSaveTarget(candidate);
    },
    [lists.data, saveMutation],
  );

  const toggleCompare = useCallback(
    (candidate: Candidate) => {
      setCompare((current) => {
        if (current.some((c) => c.id === candidate.id)) {
          return current.filter((c) => c.id !== candidate.id);
        }
        if (current.length >= 4) {
          toast('Compare up to four candidates at a time.', { tone: 'error' });
          return current;
        }
        return [...current, candidate];
      });
    },
    [toast],
  );

  /* ----------------------------------------------------- keyboard control */

  const { index: activeIndex, setIndex: setActiveIndex } = useListNavigation(candidates, {
    onSelect: (candidate) => setOpenLogin(candidate.login),
    enabled: !openLogin && !saveTarget,
  });

  useHotkeys([
    {
      combo: '/',
      handler: () => searchInputRef.current?.focus(),
      description: 'Focus search',
    },
    {
      combo: 's',
      handler: () => {
        const candidate = candidates[activeIndex];
        if (candidate && can('list:write')) handleSave(candidate);
      },
      description: 'Save the highlighted candidate',
    },
    {
      combo: 'c',
      handler: () => {
        const candidate = candidates[activeIndex];
        if (candidate) toggleCompare(candidate);
      },
      description: 'Add the highlighted candidate to the comparison',
    },
    {
      combo: 'escape',
      handler: () => {
        setOpenLogin(null);
        setSaveTarget(null);
        searchInputRef.current?.blur();
      },
      allowInInput: true,
      description: 'Close / blur',
    },
  ]);

  const canSave = can('list:write');

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      {/* Screen-reader announcements for result counts and save confirmations. */}
      <div className="sr-only-live" role="status" aria-live="polite">
        {message}
      </div>

      {/* ---------------------------------------------------------- search */}
      <div className="mb-4">
        <div className="relative">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>

          <input
            ref={searchInputRef}
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            type="search"
            // A real label exists below for assistive tech; the placeholder is
            // an example, not a substitute for one.
            aria-label="Search candidates"
            placeholder="Describe the engineer you need - 'rust systems programmer shipping async runtimes'"
            className="input py-3 pl-10 pr-24 text-sm"
            autoComplete="off"
            spellCheck={false}
          />

          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs text-subtle sm:block">
            /
          </kbd>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-2xs text-muted">
            {search.isFetching && !search.isFetchingNextPage ? (
              <span>Searching...</span>
            ) : (
              <>
                <span>
                  <strong className="font-semibold text-ink">{compactNumber(total)}</strong>{' '}
                  {total === 1 ? 'candidate' : 'candidates'}
                </span>
                {tookMs > 0 && <span className="text-subtle">{tookMs}ms</span>}
                {effectiveFilters.mode !== 'hybrid' && (
                  <Badge tone="brand">{effectiveFilters.mode} ranking</Badge>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="sort-select">
              Sort results
            </label>
            <select
              id="sort-select"
              value={filters.sort}
              onChange={(e) => setFilters({ sort: e.target.value as Filters['sort'] })}
              className="input w-auto py-1.5 text-xs"
            >
              <option value="relevance">Best match</option>
              <option value="stars">Most stars</option>
              <option value="followers">Most followers</option>
              <option value="recent">Most recently active</option>
            </select>

            {!isDesktop && (
              <button
                onClick={() => setFiltersOpen((o) => !o)}
                aria-expanded={filtersOpen}
                className="btn-secondary py-1.5 text-xs"
              >
                Filters
                {activeCount > 0 && <Badge tone="brand">{activeCount}</Badge>}
              </button>
            )}
          </div>
        </div>
      </div>

      <SavedSearchBar filters={filters} onApply={(next) => setFilters(next)} />

      {/* ------------------------------------------------------ main layout */}
      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[264px_minmax(0,1fr)]">
        {/*
          On mobile the sidebar collapses behind a toggle rather than being
          hidden entirely, so filters remain reachable on a phone.
        */}
        <aside className={cn('lg:block', filtersOpen ? 'block' : 'hidden')}>
          <FilterPanel
            filters={filters}
            facets={facets.data}
            activeCount={activeCount}
            onChange={setFilters}
            onToggle={toggleValue}
            onClear={clearFilters}
          />
        </aside>

        <main id="main" className="min-w-0">
          {search.isError ? (
            <ErrorNotice error={search.error} onRetry={() => void search.refetch()} />
          ) : (
            <ResultList
              candidates={candidates}
              activeIndex={activeIndex}
              savedIds={savedIds.data ?? new Set()}
              selectedIds={new Set(compare.map((c) => c.id))}
              canSave={canSave}
              isLoading={search.isLoading}
              isFetchingMore={search.isFetchingNextPage}
              hasMore={Boolean(search.hasNextPage)}
              onLoadMore={() => void search.fetchNextPage()}
              onOpen={setOpenLogin}
              onSave={handleSave}
              onToggleCompare={toggleCompare}
              onSetActive={setActiveIndex}
              emptyAction={
                activeCount > 0 ? (
                  <button onClick={clearFilters} className="btn-secondary">
                    Clear {activeCount} {activeCount === 1 ? 'filter' : 'filters'}
                  </button>
                ) : undefined
              }
            />
          )}
        </main>
      </div>

      {/* ---------------------------------------------------------- overlays */}
      {compare.length > 0 && (
        <CompareTray
          candidates={compare}
          onRemove={(id) => setCompare((c) => c.filter((x) => x.id !== id))}
          onClear={() => setCompare([])}
        />
      )}

      {saveTarget && (
        <SaveToPipeline
          candidate={saveTarget}
          lists={lists.data ?? []}
          onClose={() => setSaveTarget(null)}
          onSave={(listId) => {
            saveMutation.mutate({ listId, candidate: saveTarget });
            setSaveTarget(null);
          }}
        />
      )}

      {openLogin && (
        <CandidateDrawer
          login={openLogin}
          onClose={() => setOpenLogin(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
