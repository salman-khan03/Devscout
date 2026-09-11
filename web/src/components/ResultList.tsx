import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CandidateCard } from './CandidateCard';
import { CardSkeleton, EmptyState, Spinner } from './ui';
import { useIntersection } from '../hooks';
import type { Candidate } from '../lib/types';

/**
 * The results list: virtualised, infinitely scrolled, keyboard navigable.
 *
 * WHY VIRTUALISE. The fusion pool returns up to 500 candidates and each card is
 * a moderately heavy subtree. Rendering all of them costs thousands of DOM
 * nodes and makes scrolling stutter on a mid-range laptop. The virtualiser
 * keeps only the visible window plus a small overscan mounted, so scroll cost
 * is constant in the number of results.
 *
 * WHY IT IS TRICKY WITH INFINITE SCROLL. A virtualiser needs to know the total
 * scroll height, which means it needs a row count. Rather than measure a
 * sentinel inside the virtual window - where it would be unmounted most of the
 * time and never trigger - the sentinel lives outside the virtualised
 * container, below it. The intersection observer therefore fires on real
 * viewport geometry rather than on whatever the virtualiser happens to have
 * mounted.
 *
 * ACCESSIBILITY. The container is a listbox with aria-activedescendant, so
 * arrow keys move a single active option instead of moving DOM focus through
 * every row. That is what keeps the tab order one stop long no matter how many
 * results there are, and it is why each card renders role="option" with a
 * stable id.
 */
interface Props {
  candidates: Candidate[];
  activeIndex: number;
  savedIds: Set<string>;
  selectedIds: Set<string>;
  canSave: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (login: string) => void;
  onSave: (candidate: Candidate) => void;
  onToggleCompare: (candidate: Candidate) => void;
  onSetActive: (index: number) => void;
  emptyAction?: React.ReactNode;
}

/** Estimated card height. The virtualiser measures the real one after mount. */
const ESTIMATED_ROW = 186;
const GAP = 10;

export function ResultList({
  candidates,
  activeIndex,
  savedIds,
  selectedIds,
  canSave,
  isLoading,
  isFetchingMore,
  hasMore,
  onLoadMore,
  onOpen,
  onSave,
  onToggleCompare,
  onSetActive,
  emptyAction,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: candidates.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW + GAP,
    // Enough rows above and below to cover a fast flick without blank frames.
    overscan: 6,
    // Cards vary in height with bio length, so keying by id lets the
    // virtualiser cache each measured height and reuse it across renders.
    getItemKey: (index) => candidates[index]?.id ?? index,
  });

  const sentinelRef = useIntersection(onLoadMore, {
    enabled: hasMore && !isFetchingMore && !isLoading,
  });

  // Keep the keyboard cursor on screen. Without this, pressing j past the
  // bottom of the window moves an active row that nobody can see.
  useEffect(() => {
    if (activeIndex < 0 || activeIndex >= candidates.length) return;
    virtualizer.scrollToIndex(activeIndex, { align: 'auto', behavior: 'auto' });
  }, [activeIndex, candidates.length, virtualizer]);

  if (isLoading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading results">
        {Array.from({ length: 5 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!candidates.length) {
    return (
      <EmptyState
        title="No candidates match those filters"
        description="Try removing a filter, widening the activity window, or describing the work instead of naming the stack."
        action={emptyAction}
      />
    );
  }

  const items = virtualizer.getVirtualItems();
  const activeId = candidates[activeIndex]?.id;

  return (
    <>
      <div
        ref={scrollRef}
        // A bounded, scrollable viewport is what the virtualiser measures
        // against. Height is capped relative to the viewport so the list
        // scrolls internally on desktop and the page scrolls on mobile.
        className="max-h-[calc(100vh-13rem)] overflow-y-auto pr-1"
        role="listbox"
        aria-label={`${candidates.length} candidates`}
        aria-activedescendant={activeId ? `result-${activeId}` : undefined}
        tabIndex={0}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const candidate = candidates[item.index];
            if (!candidate) return null;

            return (
              <div
                key={item.key}
                // measureElement feeds the real rendered height back, so a
                // long bio does not overlap the card below it.
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)`, paddingBottom: GAP }}
              >
                <CandidateCard
                  candidate={candidate}
                  isActive={item.index === activeIndex}
                  isSaved={savedIds.has(candidate.id)}
                  isSelected={selectedIds.has(candidate.id)}
                  canSave={canSave}
                  onOpen={onOpen}
                  onSave={onSave}
                  onToggleCompare={onToggleCompare}
                  onHover={() => onSetActive(item.index)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Outside the virtualised container on purpose - see the note above. */}
      <div ref={sentinelRef} className="h-1" aria-hidden="true" />

      {isFetchingMore && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted">
          <Spinner />
          Loading more candidates
        </div>
      )}

      {!hasMore && candidates.length > 12 && (
        <p className="py-4 text-center text-2xs text-subtle">
          End of results. Ranking is computed over the top {candidates.length} candidates for this
          query.
        </p>
      )}
    </>
  );
}
