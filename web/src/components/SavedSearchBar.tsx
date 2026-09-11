import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { countActiveFilters } from '../hooks/useUrlFilters';
import { cn, relativeTime } from '../lib/format';
import { Dialog, Field, Spinner, useToast } from './ui';
import type { Filters, SavedSearch } from '../lib/types';

/**
 * Saved searches.
 *
 * A saved search is the same object as a shareable link: both are just the
 * filter state, which is why this component can store `filters` verbatim and
 * apply it back through the URL. Nothing here duplicates the search logic - it
 * hands a filter set to the page and the page re-runs the query.
 *
 * The row is deliberately a strip of chips rather than a sidebar section: it
 * sits directly under the query box because the most common action is "run the
 * search I set up yesterday", and that should be one click from arriving.
 */
export function SavedSearchBar({
  filters,
  onApply,
}: {
  filters: Filters;
  onApply: (next: Partial<Filters>) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const canRead = can('savedSearch:read');
  const canWrite = can('savedSearch:write');

  const saved = useQuery({
    queryKey: ['saved-searches'],
    queryFn: api.savedSearches,
    enabled: canRead,
    staleTime: 120_000,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createSavedSearch({
        name: name.trim(),
        query: filters.q,
        // The whole filter set is stored, not just the text, so re-running it
        // reproduces the result list exactly rather than approximately.
        filters,
      }),
    onSuccess: (search) => {
      void qc.invalidateQueries({ queryKey: ['saved-searches'] });
      setNaming(false);
      setName('');
      toast(`Saved "${search.name}"`, { tone: 'success' });
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not save this search', { tone: 'error' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSavedSearch(id),
    // Optimistic: the chip disappears on click. Deleting a saved search is
    // trivially repeatable, so waiting on the round trip buys nothing.
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['saved-searches'] });
      const previous = qc.getQueryData<SavedSearch[]>(['saved-searches']);
      qc.setQueryData<SavedSearch[]>(['saved-searches'], (old) =>
        (old ?? []).filter((s) => s.id !== id),
      );
      return { previous };
    },
    onError: (e, _id, context) => {
      if (context?.previous) qc.setQueryData(['saved-searches'], context.previous);
      toast(e instanceof Error ? e.message : 'Could not delete that search', { tone: 'error' });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });

  const apply = (search: SavedSearch) => {
    onApply({ ...search.filters, q: search.query });
    // Fire-and-forget: the run counter is telemetry, and a failed increment
    // must not stop the search the user asked for.
    api.runSavedSearch(search.id).catch(() => {});
    void qc.invalidateQueries({ queryKey: ['saved-searches'] });
  };

  const searches = saved.data ?? [];
  const hasQuery = Boolean(filters.q.trim()) || countActiveFilters(filters) > 0;

  if (!canRead) return null;
  if (!searches.length && !hasQuery) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {searches.length > 0 && <span className="label mr-0.5">Saved</span>}

        {searches.map((search) => (
          // A chip is a button plus a delete affordance. They are siblings
          // rather than nested, because a button inside a button is invalid
          // markup and breaks keyboard activation.
          <span
            key={search.id}
            className="group inline-flex items-center overflow-hidden rounded-full border border-line bg-raised transition hover:border-brand"
          >
            <button
              onClick={() => apply(search)}
              title={
                `${search.query || 'no query text'}` +
                (search.last_run_at ? ` — last run ${relativeTime(search.last_run_at)}` : '')
              }
              className="max-w-[180px] truncate py-0.5 pl-2.5 pr-1.5 text-xs font-medium text-muted group-hover:text-brand"
            >
              {search.name}
              {search.is_shared && <span className="ml-1 text-subtle">· team</span>}
            </button>

            {canWrite && (
              <button
                onClick={() => remove.mutate(search.id)}
                aria-label={`Delete saved search "${search.name}"`}
                className="pr-2 pl-0.5 text-subtle hover:text-danger"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </span>
        ))}

        {canWrite && hasQuery && (
          <button
            onClick={() => {
              // Seed the name from the query so the common case is one Enter.
              setName(filters.q.trim().slice(0, 60));
              setNaming(true);
            }}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-0.5 text-xs text-muted transition hover:border-brand hover:text-brand"
          >
            + Save this search
          </button>
        )}
      </div>

      <Dialog
        open={naming}
        onClose={() => setNaming(false)}
        title="Save this search"
        description="Stores the query and every filter, so re-running it reproduces this exact result list."
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="space-y-3"
        >
          <Field label="Name" hint="For example: Senior Rust, EU, active this quarter">
            {(props) => (
              <input
                {...props}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="input"
                placeholder="Senior Rust, EU"
              />
            )}
          </Field>

          <p className="text-2xs text-subtle">
            {countActiveFilters(filters)} filter
            {countActiveFilters(filters) === 1 ? '' : 's'} will be saved with it.
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setNaming(false)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || create.isPending}
              className={cn('btn-primary', create.isPending && 'opacity-70')}
            >
              {create.isPending && <Spinner />}
              Save search
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
