import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cn, compactNumber, languageColor } from '../lib/format';
import { Dialog, ErrorNotice, Spinner } from './ui';
import type { Candidate, CandidateDetail } from '../lib/types';

/**
 * Side-by-side comparison.
 *
 * Two parts: a persistent tray that collects candidates while you browse, and
 * a matrix that opens on demand. The tray is the important half - shortlisting
 * happens while scrolling, and a recruiter should be able to keep adding people
 * without losing their place in the results.
 *
 * The comparison itself is one request for all of them, and the shared axes
 * (the union of their languages and topics) are computed server-side, so this
 * renders a matrix rather than reconciling four differently-shaped profiles.
 */

/** The numeric metric keys the compare endpoint advertises. */
type MetricKey = keyof Pick<
  CandidateDetail,
  'totalStars' | 'followers' | 'originalRepos' | 'recentPushes' | 'activityScore' | 'impactScore'
>;

export function CompareTray({
  candidates,
  onRemove,
  onClear,
}: {
  candidates: Candidate[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);

  // The endpoint needs at least two people to compare, which is also the point
  // at which a comparison means anything.
  const canCompare = candidates.length >= 2;

  return (
    <>
      <div
        // Sits above the list but below dialogs, and is announced as a region
        // so a screen-reader user can jump to it rather than hunting for it.
        role="region"
        aria-label={`Comparison tray, ${candidates.length} selected`}
        className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 animate-slide-up"
      >
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface/95 px-3 py-2.5 shadow-pop backdrop-blur">
          <ul className="flex min-w-0 flex-1 items-center gap-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="relative shrink-0">
                <img
                  src={c.avatarUrl ?? ''}
                  alt={c.name || c.login}
                  width={32}
                  height={32}
                  loading="lazy"
                  className="h-8 w-8 rounded-lg bg-raised object-cover"
                />
                <button
                  onClick={() => onRemove(c.id)}
                  aria-label={`Remove ${c.login} from comparison`}
                  className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full border border-line bg-surface text-subtle hover:text-danger"
                >
                  <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}

            <li className="ml-1 min-w-0 truncate text-2xs text-subtle">
              {canCompare
                ? `${candidates.length} selected · up to 4`
                : 'Pick one more to compare'}
            </li>
          </ul>

          <div className="flex shrink-0 items-center gap-1.5">
            <button onClick={onClear} className="btn-ghost py-1.5 text-xs">
              Clear
            </button>
            <button
              onClick={() => setOpen(true)}
              disabled={!canCompare}
              className="btn-primary py-1.5 text-xs"
            >
              Compare
            </button>
          </div>
        </div>
      </div>

      {open && (
        <CompareDialog
          logins={candidates.map((c) => c.login)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CompareDialog({ logins, onClose }: { logins: string[]; onClose: () => void }) {
  const compare = useQuery({
    queryKey: ['compare', [...logins].sort()],
    queryFn: () => api.compare(logins),
    staleTime: 60_000,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Compare candidates"
      description="Strongest figure in each row is highlighted. Language and topic rows show the union across everyone selected."
      size="lg"
    >
      {compare.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner />
          Loading profiles
        </div>
      ) : compare.isError ? (
        <ErrorNotice error={compare.error} onRetry={() => void compare.refetch()} />
      ) : !compare.data ? null : (
        (() => {
          const { profiles, axes } = compare.data;
          const metrics = axes.metrics as Array<{ key: MetricKey; label: string }>;

          return (
            /* Wide tables scroll inside their own container so the dialog
               itself never scrolls sideways. */
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[520px] border-collapse text-sm">
                <caption className="sr-only">
                  Comparison of {profiles.map((p) => p.login).join(', ')}
                </caption>

                <thead>
                  <tr>
                    <th scope="col" className="w-32 pb-3 text-left align-bottom">
                      <span className="label">Candidate</span>
                    </th>
                    {profiles.map((p) => (
                      <th key={p.id} scope="col" className="pb-3 text-left align-bottom">
                        <div className="flex items-center gap-2">
                          <img
                            src={p.avatarUrl ?? ''}
                            alt=""
                            width={28}
                            height={28}
                            className="h-7 w-7 shrink-0 rounded-md bg-raised object-cover"
                          />
                          <span className="min-w-0">
                            <a
                              href={p.htmlUrl ?? '#'}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="block truncate text-xs font-semibold hover:text-brand hover:underline"
                            >
                              {p.name || p.login}
                            </a>
                            <span className="block truncate font-mono text-2xs font-normal text-subtle">
                              @{p.login}
                            </span>
                          </span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-line">
                  {metrics.map((metric) => {
                    const values = profiles.map((p) => Number(p[metric.key] ?? 0));
                    const best = Math.max(...values);

                    return (
                      <tr key={metric.key}>
                        <th scope="row" className="py-2 pr-3 text-left text-xs font-normal text-muted">
                          {metric.label}
                        </th>
                        {profiles.map((p, i) => (
                          <td key={p.id} className="py-2 pr-3 font-mono text-xs">
                            <span
                              className={cn(
                                // Only a genuine, unique lead is highlighted -
                                // marking every cell when all are zero would
                                // be noise dressed up as insight.
                                best > 0 && values[i] === best
                                  ? 'font-semibold text-ink'
                                  : 'text-muted',
                              )}
                            >
                              {compactNumber(values[i])}
                            </span>
                          </td>
                        ))}
                      </tr>
                    );
                  })}

                  <tr>
                    <th scope="row" className="py-2 pr-3 text-left text-xs font-normal text-muted">
                      Seniority
                    </th>
                    {profiles.map((p) => (
                      <td key={p.id} className="py-2 pr-3 text-xs text-muted">
                        {p.seniority ?? '—'}
                      </td>
                    ))}
                  </tr>

                  {axes.languages.map((language) => (
                    <tr key={`lang-${language}`}>
                      <th scope="row" className="py-1.5 pr-3 text-left text-xs font-normal">
                        <span className="flex items-center gap-1.5 text-muted">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: languageColor(language) }}
                            aria-hidden="true"
                          />
                          {language}
                        </span>
                      </th>
                      {profiles.map((p) => {
                        const share = p.languages.find((l) => l.language === language);
                        return (
                          <td key={p.id} className="py-1.5 pr-3">
                            {share ? (
                              <span className="flex items-center gap-1.5">
                                {/* A bar as well as a number: the point of
                                    this row is relative weight, which reads
                                    faster as a length than as a percentage. */}
                                <span className="h-1.5 w-10 overflow-hidden rounded-full bg-line/60">
                                  <span
                                    className="block h-full rounded-full"
                                    style={{
                                      width: `${share.pct}%`,
                                      background: languageColor(language),
                                    }}
                                  />
                                </span>
                                <span className="font-mono text-2xs text-muted">{share.pct}%</span>
                              </span>
                            ) : (
                              <span className="text-2xs text-subtle">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}

                  {axes.topics.length > 0 && (
                    <tr>
                      <th scope="row" className="py-2 pr-3 align-top text-left text-xs font-normal text-muted">
                        Topics
                      </th>
                      {profiles.map((p) => (
                        <td key={p.id} className="py-2 pr-3">
                          <span className="flex flex-wrap gap-1">
                            {axes.topics
                              .filter((t) => p.topics.includes(t))
                              .slice(0, 6)
                              .map((t) => (
                                <span key={t} className="chip text-2xs">
                                  {t}
                                </span>
                              ))}
                          </span>
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          );
        })()
      )}
    </Dialog>
  );
}
