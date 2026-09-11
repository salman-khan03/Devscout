import { memo } from 'react';
import { cn, compactNumber, languageColor, relativeTime } from '../lib/format';
import { Badge } from './ui';
import type { Candidate } from '../lib/types';

/**
 * One search result.
 *
 * memo'd because the virtualiser re-renders the window on every scroll frame;
 * without it, scrolling repaints every visible card even though none of their
 * props changed. The comparator is explicit about the handful of fields that
 * actually affect the output, so a new-but-equal `candidate` object from a
 * refetch does not force a repaint either.
 */
interface Props {
  candidate: Candidate;
  isActive: boolean;
  isSaved: boolean;
  isSelected: boolean;
  canSave: boolean;
  onOpen: (login: string) => void;
  onSave: (candidate: Candidate) => void;
  onToggleCompare: (candidate: Candidate) => void;
  onHover: () => void;
}

function CandidateCardImpl({
  candidate: c,
  isActive,
  isSaved,
  isSelected,
  canSave,
  onOpen,
  onSave,
  onToggleCompare,
  onHover,
}: Props) {
  const topLanguages = c.languages.slice(0, 3);

  return (
    <article
      onMouseEnter={onHover}
      // The card is a listbox option: the parent owns focus and moves an
      // active descendant, which is what keeps a virtualised list navigable
      // without putting thousands of elements in the tab order.
      role="option"
      aria-selected={isActive}
      id={`result-${c.id}`}
      className={cn(
        'group relative rounded-xl border bg-surface p-4 transition',
        isActive ? 'border-brand ring-2 ring-brand/20' : 'border-line hover:border-brand/40',
      )}
    >
      <div className="flex gap-3">
        <img
          src={c.avatarUrl ?? ''}
          alt=""
          loading="lazy"
          width={44}
          height={44}
          className="h-11 w-11 shrink-0 rounded-lg bg-raised object-cover"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <button
              onClick={() => onOpen(c.login)}
              className="truncate text-sm font-semibold text-ink hover:text-brand hover:underline"
            >
              {c.name || c.login}
            </button>
            <span className="truncate font-mono text-2xs text-subtle">@{c.login}</span>

            {c.isSynthetic && (
              /* Demo rows are labelled everywhere they appear, so synthetic
                 data is never mistaken for a real person. */
              <Badge tone="warning">Demo data</Badge>
            )}
          </div>

          {c.roleFit && <p className="mt-0.5 truncate text-xs text-brand">{c.roleFit}</p>}

          {c.bio && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">{c.bio}</p>}

          {/* Evidence: the single strongest verifiable reason this person
              matched, quoted from their own profile. */}
          {c.evidence.reasons[0] && (
            <p className="mt-2 flex items-start gap-1.5 text-2xs text-muted">
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="mt-0.5 shrink-0 text-positive"
                aria-hidden="true"
              >
                <path
                  d="M3 8.5l3.5 3.5L13 5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="line-clamp-1">{c.evidence.reasons[0]}</span>
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {topLanguages.map((l) => (
              <span key={l.language} className="chip gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: languageColor(l.language) }}
                  aria-hidden="true"
                />
                {l.language}
                <span className="text-subtle">{l.pct}%</span>
              </span>
            ))}
            {c.seniority && <span className="chip">{c.seniority}</span>}
          </div>

          <dl className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
            <div className="flex items-center gap-1">
              <dt className="sr-only">Stars</dt>
              <span aria-hidden="true">*</span>
              <dd>{compactNumber(c.totalStars)}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt>Followers</dt>
              <dd className="font-medium text-muted">{compactNumber(c.followers)}</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt>Repos</dt>
              <dd className="font-medium text-muted">{compactNumber(c.originalRepos)}</dd>
            </div>
            {c.location && (
              <div className="flex items-center gap-1">
                <dt className="sr-only">Location</dt>
                <dd className="truncate">{c.location}</dd>
              </div>
            )}
            <div className="flex items-center gap-1">
              <dt className="sr-only">Last active</dt>
              <dd>Active {relativeTime(c.lastActiveAt)}</dd>
            </div>
          </dl>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {canSave && (
            <button
              onClick={() => onSave(c)}
              aria-pressed={isSaved}
              aria-label={isSaved ? `${c.login} is saved` : `Save ${c.login} to a pipeline`}
              className={cn(
                'btn h-8 w-8 p-0',
                isSaved
                  ? 'bg-brand-soft text-brand'
                  : 'border border-line text-muted hover:border-brand hover:text-brand',
              )}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 2h8a1 1 0 011 1v11l-5-3-5 3V3a1 1 0 011-1z"
                  fill={isSaved ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}

          <button
            onClick={() => onToggleCompare(c)}
            aria-pressed={isSelected}
            aria-label={isSelected ? `Remove ${c.login} from comparison` : `Add ${c.login} to comparison`}
            className={cn(
              'btn h-8 w-8 p-0',
              isSelected
                ? 'bg-brand-soft text-brand'
                : 'border border-line text-muted hover:border-brand hover:text-brand',
            )}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 4h5M2 8h5M2 12h5M9 4h5M9 8h5M9 12h5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </article>
  );
}

export const CandidateCard = memo(
  CandidateCardImpl,
  (a, b) =>
    a.candidate.id === b.candidate.id &&
    a.candidate.score === b.candidate.score &&
    a.isActive === b.isActive &&
    a.isSaved === b.isSaved &&
    a.isSelected === b.isSelected &&
    a.canSave === b.canSave,
);
