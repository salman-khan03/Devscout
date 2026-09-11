import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { cn, compactNumber, downloadBlob, languageColor, relativeTime, STAGE_LABELS } from '../lib/format';
import { CandidateDrawer } from '../components/CandidateDrawer';
import { Badge, Dialog, EmptyState, ErrorNotice, Field, Spinner, useToast } from '../components/ui';
import type { ListDetail, ListMember, Stage } from '../lib/types';

/**
 * Pipelines: the board a recruiter actually works in.
 *
 * The selected pipeline lives in the route (`/pipelines/:listId`) rather than
 * in state, so a board can be linked to, bookmarked and reached with the back
 * button - the same reasoning behind keeping search filters in the URL.
 *
 * Stage moves are optimistic. Moving someone from Screening to Interview is a
 * gesture, not a transaction, and making the card wait for a round trip before
 * it moves makes the board feel broken.
 */
export default function PipelinesPage() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { can } = useSession();

  const [creating, setCreating] = useState(false);
  const [openLogin, setOpenLogin] = useState<string | null>(null);

  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists, staleTime: 60_000 });

  // Land on the default pipeline rather than an empty chooser.
  useEffect(() => {
    if (listId || !lists.data?.length) return;
    const fallback = lists.data.find((l) => l.is_default) ?? lists.data[0];
    navigate(`/pipelines/${fallback.id}`, { replace: true });
  }, [listId, lists.data, navigate]);

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* ------------------------------------------------------- sidebar */}
        <aside>
          <div className="mb-2 flex items-center justify-between">
            <h1 className="label">Pipelines</h1>
            {can('list:write') && (
              <button
                onClick={() => setCreating(true)}
                className="text-xs text-muted hover:text-brand"
              >
                + New
              </button>
            )}
          </div>

          {lists.isLoading ? (
            <div className="space-y-1.5">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton h-9 rounded-lg" />
              ))}
            </div>
          ) : (
            <ul className="space-y-1 overflow-x-auto lg:overflow-visible">
              {(lists.data ?? []).map((list) => (
                <li key={list.id}>
                  <Link
                    to={`/pipelines/${list.id}`}
                    aria-current={list.id === listId ? 'page' : undefined}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs transition',
                      list.id === listId
                        ? 'bg-brand-soft font-medium text-brand'
                        : 'text-muted hover:bg-raised hover:text-ink',
                    )}
                  >
                    <span className="min-w-0 truncate">{list.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-subtle">
                      {list.member_count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* --------------------------------------------------------- board */}
        <main id="main" className="min-w-0">
          {listId ? (
            <Board listId={listId} onOpen={setOpenLogin} />
          ) : lists.isSuccess && !lists.data.length ? (
            <EmptyState
              title="No pipelines yet"
              description="A pipeline is where you collect candidates and move them through your process."
              action={
                can('list:write') ? (
                  <button onClick={() => setCreating(true)} className="btn-primary">
                    Create a pipeline
                  </button>
                ) : undefined
              }
            />
          ) : null}
        </main>
      </div>

      {creating && <CreateListDialog onClose={() => setCreating(false)} />}

      {openLogin && (
        <CandidateDrawer
          login={openLogin}
          onClose={() => setOpenLogin(null)}
          // Saving from inside a pipeline board would be circular - the person
          // is already saved. The drawer simply does not offer it here.
          onSave={() => setOpenLogin(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- board */

function Board({ listId, onOpen }: { listId: string; onOpen: (login: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useSession();

  const detail = useQuery({
    queryKey: ['list', listId],
    queryFn: () => api.list(listId),
    staleTime: 30_000,
  });

  const moveStage = useMutation({
    mutationFn: ({ memberId, stage }: { memberId: string; stage: Stage }) =>
      api.updateMember(listId, memberId, { stage }),

    onMutate: async ({ memberId, stage }) => {
      await qc.cancelQueries({ queryKey: ['list', listId] });
      const previous = qc.getQueryData<ListDetail>(['list', listId]);

      qc.setQueryData<ListDetail>(['list', listId], (old) =>
        old
          ? { ...old, members: old.members.map((m) => (m.id === memberId ? { ...m, stage } : m)) }
          : old,
      );

      return { previous };
    },

    onError: (error, _vars, context) => {
      if (context?.previous) qc.setQueryData(['list', listId], context.previous);
      toast(error instanceof Error ? error.message : 'Could not move that candidate', {
        tone: 'error',
      });
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['list', listId] });
      // Column counts on the sidebar come from the list index.
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
  });

  const rate = useMutation({
    mutationFn: ({ memberId, rating }: { memberId: string; rating: number | null }) =>
      api.updateMember(listId, memberId, { rating }),
    onMutate: async ({ memberId, rating }) => {
      await qc.cancelQueries({ queryKey: ['list', listId] });
      const previous = qc.getQueryData<ListDetail>(['list', listId]);
      qc.setQueryData<ListDetail>(['list', listId], (old) =>
        old
          ? { ...old, members: old.members.map((m) => (m.id === memberId ? { ...m, rating } : m)) }
          : old,
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) qc.setQueryData(['list', listId], context.previous);
      toast(error instanceof Error ? error.message : 'Could not save that rating', { tone: 'error' });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['list', listId] }),
  });

  const remove = useMutation({
    mutationFn: (memberId: string) => api.removeFromList(listId, memberId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['list', listId] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
      void qc.invalidateQueries({ queryKey: ['saved-ids'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not remove', { tone: 'error' }),
  });

  const deleteList = useMutation({
    mutationFn: () => api.deleteList(listId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lists'] });
      navigate('/pipelines', { replace: true });
      toast('Pipeline deleted', { tone: 'success' });
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not delete that pipeline', { tone: 'error' }),
  });

  const exportCsv = useMutation({
    mutationFn: () => api.exportCsv(listId),
    onSuccess: (blob) => {
      downloadBlob(blob, `devscout-${detail.data?.name ?? 'pipeline'}.csv`.replace(/\s+/g, '-'));
      toast('Export downloaded', { tone: 'success' });
    },
    onError: (error) => {
      // CSV export is a paid feature, so a 402 is an upsell, not a failure.
      if (error instanceof ApiError && error.isPlanLimit) {
        toast(error.message, {
          tone: 'error',
          action: { label: 'See plans', onClick: () => navigate('/pricing') },
        });
        return;
      }
      toast(error instanceof Error ? error.message : 'Export failed', { tone: 'error' });
    },
  });

  if (detail.isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="w-64 shrink-0 space-y-2">
            <div className="skeleton h-7 rounded-lg" />
            <div className="skeleton h-24 rounded-xl" />
            <div className="skeleton h-24 rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (detail.isError) {
    return <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  const list = detail.data;
  if (!list) return null;

  const byStage = (stage: Stage) => list.members.filter((m) => m.stage === stage);
  const canWrite = can('list:write');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{list.name}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {list.members.length} {list.members.length === 1 ? 'candidate' : 'candidates'}
            {list.description ? ` · ${list.description}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {can('export:csv') && list.members.length > 0 && (
            <button
              onClick={() => exportCsv.mutate()}
              disabled={exportCsv.isPending}
              className="btn-secondary py-1.5 text-xs"
            >
              {exportCsv.isPending && <Spinner />}
              Export CSV
            </button>
          )}
          {canWrite && !list.is_default && (
            <button
              onClick={() => {
                if (confirm(`Delete "${list.name}"? The candidates stay in your workspace.`)) {
                  deleteList.mutate();
                }
              }}
              className="btn-ghost py-1.5 text-xs hover:text-danger"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {!list.members.length ? (
        <EmptyState
          title="Nothing in this pipeline yet"
          description="Save candidates from search and they will land in the first column."
          action={
            <Link to="/" className="btn-primary">
              Find candidates
            </Link>
          }
        />
      ) : (
        /*
         * Columns scroll horizontally as a group on narrow screens rather than
         * reflowing into a single stack, because a board's meaning is the
         * left-to-right progression through stages.
         */
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          {list.stages.map((stage) => {
            const members = byStage(stage);
            return (
              <section
                key={stage}
                aria-label={`${STAGE_LABELS[stage] ?? stage}, ${members.length} candidates`}
                className="flex w-64 shrink-0 flex-col"
              >
                <header className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-raised px-2.5 py-1.5">
                  <h3 className="text-xs font-semibold">{STAGE_LABELS[stage] ?? stage}</h3>
                  <span className="font-mono text-2xs text-subtle">{members.length}</span>
                </header>

                <div className="space-y-2">
                  {members.map((member) => (
                    <MemberCard
                      key={member.id}
                      member={member}
                      stages={list.stages}
                      canWrite={canWrite}
                      onOpen={onOpen}
                      onMove={(next) => moveStage.mutate({ memberId: member.id, stage: next })}
                      onRate={(rating) => rate.mutate({ memberId: member.id, rating })}
                      onRemove={() => remove.mutate(member.id)}
                    />
                  ))}

                  {!members.length && (
                    <p className="rounded-lg border border-dashed border-line px-2.5 py-4 text-center text-2xs text-subtle">
                      Empty
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- board card */

function MemberCard({
  member: m,
  stages,
  canWrite,
  onOpen,
  onMove,
  onRate,
  onRemove,
}: {
  member: ListMember;
  stages: Stage[];
  canWrite: boolean;
  onOpen: (login: string) => void;
  onMove: (stage: Stage) => void;
  onRate: (rating: number | null) => void;
  onRemove: () => void;
}) {
  return (
    <article className="card p-2.5">
      <div className="flex gap-2">
        <img
          src={m.avatar_url ?? ''}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          className="h-7 w-7 shrink-0 rounded-md bg-raised object-cover"
        />
        <div className="min-w-0 flex-1">
          <button
            onClick={() => onOpen(m.login)}
            className="block max-w-full truncate text-xs font-semibold hover:text-brand hover:underline"
          >
            {m.name || m.login}
          </button>
          <span className="block truncate font-mono text-2xs text-subtle">@{m.login}</span>
        </div>
        {m.is_synthetic && <Badge tone="warning">Demo</Badge>}
      </div>

      {m.role_fit && <p className="mt-1.5 line-clamp-2 text-2xs text-brand">{m.role_fit}</p>}

      <div className="mt-1.5 flex flex-wrap gap-1">
        {m.languages.slice(0, 2).map((l) => (
          <span key={l.language} className="chip gap-1 text-2xs">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: languageColor(l.language) }}
              aria-hidden="true"
            />
            {l.language}
          </span>
        ))}
        {m.tags?.slice(0, 2).map((t) => (
          <span key={t} className="chip chip-active text-2xs">
            {t}
          </span>
        ))}
      </div>

      <dl className="mt-1.5 flex items-center gap-2.5 text-2xs text-subtle">
        <div className="flex gap-1">
          <dt className="sr-only">Stars</dt>
          <dd>★ {compactNumber(m.total_stars)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="sr-only">Followers</dt>
          <dd>{compactNumber(m.followers)} followers</dd>
        </div>
        {m.note_count > 0 && (
          <div className="flex gap-1">
            <dt className="sr-only">Notes</dt>
            <dd>{m.note_count} notes</dd>
          </div>
        )}
      </dl>

      {canWrite && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          {/*
            A select rather than drag-and-drop. Dragging is faster with a
            mouse; a select is operable by keyboard and screen reader, works on
            touch, and cannot drop someone into the wrong column by accident.
          */}
          <label className="sr-only" htmlFor={`stage-${m.id}`}>
            Stage for {m.login}
          </label>
          <select
            id={`stage-${m.id}`}
            value={m.stage}
            onChange={(e) => onMove(e.target.value as Stage)}
            className="input py-1 text-2xs"
          >
            {stages.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s] ?? s}
              </option>
            ))}
          </select>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-0.5" role="group" aria-label={`Rating for ${m.login}`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  // Clicking the current rating clears it, so a misclick is
                  // undoable without a separate "remove rating" control.
                  onClick={() => onRate(m.rating === n ? null : n)}
                  aria-label={`Rate ${n} out of 5`}
                  aria-pressed={m.rating === n}
                  className={cn(
                    'text-xs leading-none transition',
                    (m.rating ?? 0) >= n ? 'text-warning' : 'text-line hover:text-subtle',
                  )}
                >
                  ★
                </button>
              ))}
            </div>

            <button
              onClick={onRemove}
              className="text-2xs text-subtle hover:text-danger"
              aria-label={`Remove ${m.login} from this pipeline`}
            >
              Remove
            </button>
          </div>

          <p className="text-2xs text-subtle">
            Added {relativeTime(m.added_at)}
            {m.added_by_name ? ` by ${m.added_by_name}` : ''}
          </p>
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ create */

function CreateListDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createList({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: ['lists'] });
      navigate(`/pipelines/${list.id}`);
      onClose();
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not create that pipeline', { tone: 'error' }),
  });

  return (
    <Dialog open onClose={onClose} title="New pipeline" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Name" hint="For example: Backend Platform Q1">
          {(props) => (
            <input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="input"
              placeholder="Backend Platform Q1"
            />
          )}
        </Field>
        <Field label="Description" hint="Optional">
          {(props) => (
            <input
              {...props}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
              placeholder="Senior Go and Rust, EU time zones"
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || create.isPending} className="btn-primary">
            {create.isPending && <Spinner />}
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
