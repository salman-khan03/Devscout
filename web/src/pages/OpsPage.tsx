import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cn, compactNumber, relativeTime } from '../lib/format';
import { StatTile } from '../components/charts';
import { Badge, ErrorNotice, Field, Spinner, useToast } from '../components/ui';

/**
 * Ingestion and queue operations.
 *
 * GitHub work is queued rather than done inline: fetching a profile means
 * several API calls against a rate limit that is shared by the whole
 * deployment, and an HTTP handler is the wrong place to sit waiting for that.
 * This page is the window onto that queue - depth, failures, dead letters, and
 * the remaining rate-limit headroom.
 *
 * It polls while open. A queue view that needs a manual refresh to show
 * progress is not a queue view.
 */

const JOB_FILTERS = ['all', 'queued', 'running', 'failed', 'dead', 'succeeded'] as const;

export default function OpsPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [login, setLogin] = useState('');
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [filter, setFilter] = useState<(typeof JOB_FILTERS)[number]>('all');

  const status = useQuery({
    queryKey: ['ingest-status'],
    queryFn: api.ingestStatus,
    // Cheap aggregate query, and the numbers are the point of the page.
    refetchInterval: 5_000,
  });

  const jobs = useQuery({
    queryKey: ['ingest-jobs', filter],
    queryFn: () => api.ingestJobs(filter === 'all' ? undefined : filter),
    refetchInterval: 5_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ingest-status'] });
    void qc.invalidateQueries({ queryKey: ['ingest-jobs'] });
  };

  const enqueueProfile = useMutation({
    mutationFn: () => api.ingestProfile(login.trim()),
    onSuccess: (result) => {
      setLogin('');
      refresh();
      toast(
        result.deduped
          ? `${result.job.target} is already queued — reusing that job`
          : `Queued ${result.job.target}`,
        { tone: 'success' },
      );
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not queue', { tone: 'error' }),
  });

  const enqueueDiscover = useMutation({
    mutationFn: () => api.discover(discoverQuery.trim()),
    onSuccess: (result) => {
      setDiscoverQuery('');
      refresh();
      toast(
        result.deduped ? 'That discovery is already queued' : 'Discovery queued',
        { tone: 'success' },
      );
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not queue that discovery', { tone: 'error' }),
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.retryJob(id),
    onSuccess: () => {
      refresh();
      toast('Job requeued', { tone: 'success' });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not retry', { tone: 'error' }),
  });

  const s = status.data;
  const github = s?.github;

  /** Rate-limit headroom, as a percentage of the hourly allowance. */
  const headroom = github && github.limit > 0 ? (github.remaining / github.limit) * 100 : null;

  return (
    <main id="main" className="mx-auto max-w-[1100px] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mb-4">
        <h1 className="text-base font-semibold">Ingestion</h1>
        <p className="mt-0.5 text-xs text-muted">
          Queue depth, GitHub rate limits, and the corpus this workspace searches over.
        </p>
      </div>

      {status.isError ? (
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      ) : !s ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted">
          <Spinner />
          Loading queue
        </div>
      ) : (
        <div className="space-y-4">
          {/* ------------------------------------------------------- corpus */}
          <section aria-label="Corpus">
            <h2 className="label mb-2">Corpus</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Developers"
                value={s.corpus.developers}
                hint={`${compactNumber(s.corpus.synthetic)} synthetic`}
              />
              <StatTile
                label="With embeddings"
                value={s.corpus.embedded}
                hint={
                  s.corpus.developers
                    ? `${Math.round((s.corpus.embedded / s.corpus.developers) * 100)}% of corpus`
                    : undefined
                }
              />
              <StatTile
                label="Stale embeddings"
                value={s.corpus.stale_embeddings}
                tone={s.corpus.stale_embeddings > 0 ? 'warning' : 'neutral'}
                hint="Profile changed since it was embedded"
              />
              <StatTile
                label="Last ingest"
                value={relativeTime(s.corpus.last_ingest)}
                hint={s.embeddingModel}
              />
            </div>
          </section>

          {/* -------------------------------------------------------- queue */}
          <section aria-label="Queue">
            <h2 className="label mb-2">Queue</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatTile label="Queued" value={s.queue.queued} />
              <StatTile label="Running" value={s.queue.running} />
              <StatTile label="Succeeded" value={s.queue.succeeded} tone="positive" />
              <StatTile
                label="Failed"
                value={s.queue.failed}
                tone={s.queue.failed > 0 ? 'warning' : 'neutral'}
                hint="Will be retried"
              />
              <StatTile
                label="Dead letters"
                value={s.queue.dead}
                tone={s.queue.dead > 0 ? 'danger' : 'neutral'}
                hint="Exhausted all attempts"
              />
            </div>

            {s.queue.oldestQueuedSeconds !== null && s.queue.oldestQueuedSeconds > 120 && (
              <p className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                The oldest queued job has been waiting{' '}
                {Math.round(s.queue.oldestQueuedSeconds / 60)} minutes. Check that a worker process
                is running.
              </p>
            )}
          </section>

          {/* ------------------------------------------------------- github */}
          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold">GitHub API</h2>
              {s.githubConfigured ? (
                github?.circuitOpenUntil ? (
                  <Badge tone="danger">Circuit open</Badge>
                ) : (
                  <Badge tone="positive">Connected</Badge>
                )
              ) : (
                <Badge tone="warning">No token configured</Badge>
              )}
            </div>

            {!s.githubConfigured ? (
              <p className="mt-2 text-xs text-muted">
                Without a token the app serves the indexed corpus only. Set{' '}
                <code className="font-mono text-2xs">GITHUB_TOKEN</code> to enable live ingestion.
              </p>
            ) : github ? (
              <>
                <div className="mt-3 flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-muted">Requests remaining this hour</span>
                  <span className="font-mono text-ink">
                    {compactNumber(github.remaining)} / {compactNumber(github.limit)}
                  </span>
                </div>

                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line/60">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      // Status colours, used for status only.
                      headroom !== null && headroom < 15
                        ? 'bg-danger'
                        : headroom !== null && headroom < 40
                          ? 'bg-warning'
                          : 'bg-positive',
                    )}
                    style={{ width: `${Math.max(headroom ?? 0, 1)}%` }}
                  />
                </div>

                <p className="mt-1.5 text-2xs text-subtle">
                  Resets {relativeTime(github.resetAt)}
                  {github.circuitOpenUntil &&
                    ` · circuit breaker open until ${relativeTime(github.circuitOpenUntil)}`}
                </p>
              </>
            ) : null}
          </section>

          {/* ------------------------------------------------------ enqueue */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="card p-4">
              <h2 className="text-xs font-semibold">Ingest one profile</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                Fetches the profile and its repositories, then embeds it.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (login.trim()) enqueueProfile.mutate();
                }}
                className="mt-3 flex items-end gap-2"
              >
                <div className="flex-1">
                  <Field label="GitHub username">
                    {(props) => (
                      <input
                        {...props}
                        value={login}
                        onChange={(e) => setLogin(e.target.value)}
                        className="input"
                        placeholder="torvalds"
                        autoComplete="off"
                      />
                    )}
                  </Field>
                </div>
                <button
                  type="submit"
                  disabled={!login.trim() || enqueueProfile.isPending}
                  className="btn-primary"
                >
                  {enqueueProfile.isPending && <Spinner />}
                  Queue
                </button>
              </form>
            </section>

            <section className="card p-4">
              <h2 className="text-xs font-semibold">Discover many</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                Runs a GitHub user search and queues everyone it finds.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (discoverQuery.trim()) enqueueDiscover.mutate();
                }}
                className="mt-3 flex items-end gap-2"
              >
                <div className="flex-1">
                  <Field label="Search query" hint="GitHub search syntax">
                    {(props) => (
                      <input
                        {...props}
                        value={discoverQuery}
                        onChange={(e) => setDiscoverQuery(e.target.value)}
                        className="input"
                        placeholder="language:rust location:berlin followers:>100"
                        autoComplete="off"
                      />
                    )}
                  </Field>
                </div>
                <button
                  type="submit"
                  disabled={!discoverQuery.trim() || enqueueDiscover.isPending}
                  className="btn-primary"
                >
                  {enqueueDiscover.isPending && <Spinner />}
                  Queue
                </button>
              </form>
            </section>
          </div>

          {/* --------------------------------------------------------- jobs */}
          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold">Recent jobs</h2>

              <div
                className="flex items-center gap-0.5 rounded-lg border border-line p-0.5"
                role="group"
                aria-label="Filter jobs by status"
              >
                {JOB_FILTERS.map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={cn(
                      'rounded-md px-2 py-1 text-2xs font-medium capitalize transition',
                      filter === f ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink',
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {jobs.isLoading ? (
              <p className="py-8 text-center text-xs text-muted">Loading…</p>
            ) : jobs.data?.jobs.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="px-1 pb-2 text-left font-semibold">
                        Target
                      </th>
                      <th scope="col" className="px-1 pb-2 text-left font-semibold">
                        Kind
                      </th>
                      <th scope="col" className="px-1 pb-2 text-left font-semibold">
                        Status
                      </th>
                      <th scope="col" className="px-1 pb-2 text-right font-semibold">
                        Attempts
                      </th>
                      <th scope="col" className="px-1 pb-2 text-right font-semibold">
                        Created
                      </th>
                      <th scope="col" className="px-1 pb-2 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {jobs.data.jobs.map((job) => (
                      <tr key={job.id}>
                        <th scope="row" className="max-w-[200px] px-1 py-1.5 text-left font-normal">
                          <span className="block truncate font-mono text-2xs" title={job.target}>
                            {job.target}
                          </span>
                          {job.last_error && (
                            <span
                              className="block truncate text-2xs text-danger"
                              title={job.last_error}
                            >
                              {job.last_error}
                            </span>
                          )}
                        </th>
                        <td className="px-1 py-1.5 text-2xs text-muted">{job.kind}</td>
                        <td className="px-1 py-1.5">
                          <Badge
                            tone={
                              job.status === 'succeeded'
                                ? 'positive'
                                : job.status === 'dead'
                                  ? 'danger'
                                  : job.status === 'failed'
                                    ? 'warning'
                                    : 'neutral'
                            }
                          >
                            {job.status}
                          </Badge>
                        </td>
                        <td className="px-1 py-1.5 text-right font-mono text-2xs text-muted">
                          {job.attempts}/{job.max_attempts}
                        </td>
                        <td className="px-1 py-1.5 text-right text-2xs text-subtle">
                          {relativeTime(job.created_at)}
                        </td>
                        <td className="px-1 py-1.5 text-right">
                          {(job.status === 'dead' || job.status === 'failed') && (
                            <button
                              onClick={() => retry.mutate(job.id)}
                              className="text-2xs text-brand hover:underline"
                            >
                              Retry
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-8 text-center text-xs text-subtle">
                No {filter === 'all' ? '' : filter} jobs.
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
