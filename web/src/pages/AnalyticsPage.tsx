import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { cn, compactNumber, STAGE_LABELS } from '../lib/format';
import { BarChart, RankedBars, StatTile, TimeSeriesChart } from '../components/charts';
import { ErrorNotice, PlanLimitNotice, Spinner } from '../components/ui';

/**
 * Sourcing analytics.
 *
 * The question this page answers is "is our sourcing working", which is a
 * funnel question: how many profiles were looked at, how many were worth
 * saving, how many progressed. The conversion rates between those steps are
 * the actual signal, so they are stated outright rather than left to be
 * computed by eye from two charts.
 *
 * Zero-result queries get their own panel because they are the most actionable
 * thing here - each one is a search someone ran that the corpus could not
 * answer, which is a direct instruction about what to ingest next.
 */

const RANGES = [7, 30, 90] as const;

/** "2026-03-14T00:00:00Z" -> "14 Mar", for an axis that has to stay narrow. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(5, 10);
  return date.toLocaleDateString('en', { day: 'numeric', month: 'short' });
}

export default function AnalyticsPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const { session } = useSession();

  const analytics = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api.analytics(days),
    staleTime: 60_000,
  });

  const data = analytics.data;
  const limits = session?.org?.limits;

  return (
    <main id="main" className="mx-auto max-w-[1200px] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Analytics</h1>
          <p className="mt-0.5 text-xs text-muted">
            Sourcing funnel and search behaviour for this workspace.
          </p>
        </div>

        {/* Filters in one row above the charts. */}
        <div
          className="flex items-center gap-0.5 rounded-lg border border-line p-0.5"
          role="group"
          aria-label="Time range"
        >
          {RANGES.map((range) => (
            <button
              key={range}
              onClick={() => setDays(range)}
              aria-pressed={days === range}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition',
                days === range ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink',
              )}
            >
              {range}d
            </button>
          ))}
        </div>
      </div>

      {analytics.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted">
          <Spinner />
          Loading analytics
        </div>
      ) : analytics.error instanceof ApiError && analytics.error.isPlanLimit ? (
        <PlanLimitNotice message={analytics.error.message}>
          <Link to="/pricing" className="btn-primary">
            See plans
          </Link>
        </PlanLimitNotice>
      ) : analytics.isError ? (
        <ErrorNotice error={analytics.error} onRetry={() => void analytics.refetch()} />
      ) : !data ? null : (
        <div className="space-y-4">
          {/* ------------------------------------------------------- funnel */}
          <section aria-label="Sourcing funnel">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Profiles viewed"
                value={data.funnel.viewed}
                hint={`${compactNumber(data.funnel.unique_candidates)} unique people`}
              />
              <StatTile
                label="Shortlisted"
                value={data.funnel.shortlisted}
                hint={`${data.conversion.viewToShortlist}% of profiles viewed`}
              />
              <StatTile
                label="Advanced a stage"
                value={data.funnel.advanced}
                hint={`${data.conversion.shortlistToAdvanced}% of those shortlisted`}
              />
              <StatTile label="Exports" value={data.funnel.exported} hint="CSV downloads" />
            </div>
          </section>

          {/* ------------------------------------------------------- charts */}
          <TimeSeriesChart
            title="Sourcing activity"
            subtitle={`Profiles viewed, shortlisted and moved a stage, over ${data.days} days`}
            labels={data.timeline.map((t) => dayLabel(t.day))}
            series={[
              { key: 'viewed', label: 'Viewed', values: data.timeline.map((t) => t.viewed) },
              {
                key: 'shortlisted',
                label: 'Shortlisted',
                values: data.timeline.map((t) => t.shortlisted),
              },
              { key: 'staged', label: 'Advanced', values: data.timeline.map((t) => t.staged) },
            ]}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BarChart
              title="Search volume"
              subtitle="Searches run per day"
              labels={data.searchVolume.map((s) => dayLabel(s.day))}
              series={{
                key: 'searches',
                label: 'Searches',
                values: data.searchVolume.map((s) => s.searches),
              }}
            />

            {/*
              Latency is a second measure on a completely different scale, so
              it gets its own chart. Overlaying it on the volume chart would
              need a second y-axis, which makes both series unreadable.
            */}
            <BarChart
              title="Search latency"
              subtitle="95th percentile response time per day, milliseconds"
              labels={data.searchVolume.map((s) => dayLabel(s.day))}
              series={{
                key: 'p95',
                label: 'p95 ms',
                values: data.searchVolume.map((s) => Math.round(s.p95_took_ms ?? 0)),
              }}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RankedBars
              title="Pipeline stages"
              subtitle="Everyone currently in a pipeline, by stage"
              rows={data.stageBreakdown.map((s) => ({
                label: STAGE_LABELS[s.stage] ?? s.stage,
                value: s.n,
              }))}
              emptyMessage="No candidates in a pipeline yet."
            />

            <RankedBars
              title="Languages in your pipelines"
              subtitle="What your team is actually shortlisting for"
              rows={data.pipelineLanguages
                .slice(0, 8)
                .map((l) => ({ label: l.language, value: l.candidates }))}
              emptyMessage="Shortlist a few candidates to see this."
            />
          </div>

          {/* ------------------------------------------------------ queries */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="card p-4">
              <h2 className="text-xs font-semibold">Most-run searches</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                With the average number of results each returned.
              </p>

              {data.topQueries.length ? (
                <ul className="mt-3 divide-y divide-line">
                  {data.topQueries.slice(0, 8).map((q) => (
                    <li key={q.query} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate font-mono text-2xs text-muted" title={q.query}>
                        {q.query || '(no query text)'}
                      </span>
                      <span className="shrink-0 text-2xs text-subtle">
                        <span className="font-mono text-ink">{q.runs}x</span> ·{' '}
                        {Math.round(q.avg_results)} results
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-xs text-subtle">No searches yet.</p>
              )}
            </section>

            <section className="card p-4">
              <h2 className="text-xs font-semibold">Searches that returned nothing</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                Gaps in the corpus. Each of these is a candidate for ingestion.
              </p>

              {data.zeroResultQueries.length ? (
                <ul className="mt-3 divide-y divide-line">
                  {data.zeroResultQueries.slice(0, 8).map((q) => (
                    <li key={q.query} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate font-mono text-2xs text-muted" title={q.query}>
                        {q.query || '(no query text)'}
                      </span>
                      <span className="shrink-0 font-mono text-2xs text-warning">{q.runs}x</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-xs text-subtle">
                  Every search in this window returned results.
                </p>
              )}
            </section>
          </div>

          {/* --------------------------------------------------------- team */}
          <section className="card p-4">
            <h2 className="text-xs font-semibold">Team activity</h2>
            <p className="mt-0.5 text-2xs text-subtle">
              Who is sourcing, over the last {data.days} days.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="px-1 pb-2 text-left font-semibold">
                      Member
                    </th>
                    <th scope="col" className="px-1 pb-2 text-right font-semibold">
                      Viewed
                    </th>
                    <th scope="col" className="px-1 pb-2 text-right font-semibold">
                      Shortlisted
                    </th>
                    <th scope="col" className="px-1 pb-2 text-right font-semibold">
                      Advanced
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.teamActivity.map((member) => (
                    <tr key={member.email}>
                      <th scope="row" className="px-1 py-1.5 text-left font-normal">
                        <span className="block truncate">{member.name ?? member.email}</span>
                        {member.name && (
                          <span className="block truncate text-2xs text-subtle">{member.email}</span>
                        )}
                      </th>
                      <td className="px-1 py-1.5 text-right font-mono text-muted">{member.viewed}</td>
                      <td className="px-1 py-1.5 text-right font-mono text-muted">
                        {member.shortlisted}
                      </td>
                      <td className="px-1 py-1.5 text-right font-mono text-muted">
                        {member.advanced}
                      </td>
                    </tr>
                  ))}
                  {!data.teamActivity.length && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-xs text-subtle">
                        No recorded activity yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* -------------------------------------------------------- usage */}
          {data.usage && (
            <section aria-label="Plan usage today">
              <h2 className="label mb-2">Usage today</h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile
                  label="Searches"
                  value={data.usage.searches}
                  hint={limits?.searchesPerDay ? `of ${limits.searchesPerDay} per day` : 'unlimited'}
                />
                <StatTile
                  label="Profile scans"
                  value={data.usage.profile_scans}
                  hint={limits?.scansPerDay ? `of ${limits.scansPerDay} per day` : 'unlimited'}
                />
                <StatTile
                  label="Ingest jobs"
                  value={data.usage.ingest_jobs}
                  hint={
                    limits?.ingestJobsPerDay ? `of ${limits.ingestJobsPerDay} per day` : 'unlimited'
                  }
                />
                <StatTile label="Exports" value={data.usage.exports} hint="CSV downloads today" />
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
