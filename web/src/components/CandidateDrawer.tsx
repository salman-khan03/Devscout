import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useFocusTrap } from '../hooks';
import { cn, compactNumber, formatDate, relativeTime, STAGE_LABELS } from '../lib/format';
import { ActivityStrip, LanguageBars, Stat } from './Scorecard';
import { Badge, ErrorNotice, Spinner, useToast } from './ui';
import type { CandidateDetail, SaveableCandidate } from '../lib/types';

/**
 * The full candidate profile, in a drawer rather than a page.
 *
 * A drawer keeps the result list mounted behind it, so closing returns you to
 * the exact scroll position with no refetch - which is what makes working
 * through forty candidates feel like one task instead of forty round trips.
 *
 * Everything a recruiter writes here (notes, tags) is org-scoped and optimistic
 * where it is safe to be. Notes are not: a note is typed prose that is
 * genuinely annoying to lose, so it waits for the server to confirm.
 */
export function CandidateDrawer({
  login,
  onClose,
  onSave,
}: {
  login: string;
  onClose: () => void;
  onSave: (candidate: SaveableCandidate) => void;
}) {
  const trapRef = useFocusTrap(true);
  const { can } = useSession();

  const profile = useQuery({
    queryKey: ['candidate', login],
    queryFn: () => api.candidate(login),
    staleTime: 120_000,
  });

  // The page behind must not scroll under the overlay.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape closes. Handled here as well as by the page's hotkeys so the drawer
  // is self-contained wherever it is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const candidate = profile.data;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 animate-fade-in bg-ink/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={trapRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-label={`Profile for ${candidate?.name || login}`}
        className="relative z-10 flex h-full w-full max-w-xl animate-slide-in-right flex-col border-l border-line bg-surface shadow-pop"
      >
        {/* ------------------------------------------------------------ head */}
        <header className="flex shrink-0 items-start gap-3 border-b border-line p-4">
          {candidate ? (
            <img
              src={candidate.avatarUrl ?? ''}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 shrink-0 rounded-lg bg-raised object-cover"
            />
          ) : (
            <div className="skeleton h-12 w-12 rounded-lg" />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h2 className="truncate text-base font-semibold">
                {candidate?.name || login}
              </h2>
              <span className="truncate font-mono text-2xs text-subtle">@{login}</span>
              {candidate?.isSynthetic && <Badge tone="warning">Demo data</Badge>}
              {candidate?.hireable && <Badge tone="positive">Open to work</Badge>}
            </div>

            {candidate?.roleFit && (
              <p className="mt-0.5 text-xs text-brand">{candidate.roleFit}</p>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-subtle">
              {candidate?.location && <span>{candidate.location}</span>}
              {candidate?.company && <span>{candidate.company}</span>}
              {candidate?.htmlUrl && (
                <a
                  href={candidate.htmlUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-muted underline underline-offset-2 hover:text-brand"
                >
                  GitHub
                </a>
              )}
              {candidate?.blog && (
                <a
                  href={candidate.blog.startsWith('http') ? candidate.blog : `https://${candidate.blog}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="max-w-[180px] truncate text-muted underline underline-offset-2 hover:text-brand"
                >
                  {candidate.blog.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {candidate && can('list:write') && (
              <button onClick={() => onSave(candidate)} className="btn-secondary py-1.5 text-xs">
                Save
              </button>
            )}
            <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close profile">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </header>

        {/* ------------------------------------------------------------ body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {profile.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
              <Spinner />
              Loading profile
            </div>
          ) : profile.isError ? (
            <ErrorNotice error={profile.error} onRetry={() => void profile.refetch()} />
          ) : candidate ? (
            <ProfileBody candidate={candidate} />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProfileBody({ candidate: c }: { candidate: CandidateDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [noteDraft, setNoteDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');

  /** Everything written here is keyed to this profile, so one invalidation
   *  refreshes notes, tags and pipeline membership together. */
  const refresh = () => qc.invalidateQueries({ queryKey: ['candidate', c.login] });

  const addNote = useMutation({
    mutationFn: (body: string) => api.addNote(c.id, body),
    onSuccess: () => {
      setNoteDraft('');
      void refresh();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not save note', { tone: 'error' }),
  });

  const deleteNote = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: () => void refresh(),
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not delete note', { tone: 'error' }),
  });

  const addTag = useMutation({
    mutationFn: (label: string) => api.addTag(c.id, label),
    onSuccess: () => {
      setTagDraft('');
      void refresh();
      void qc.invalidateQueries({ queryKey: ['tags'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not add tag', { tone: 'error' }),
  });

  const deleteTag = useMutation({
    mutationFn: (id: string) => api.deleteTag(id),
    onSuccess: () => void refresh(),
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not remove tag', { tone: 'error' }),
  });

  const rescan = useMutation({
    mutationFn: () => api.refreshCandidate(c.login),
    onSuccess: () => toast('Queued a refresh from GitHub', { tone: 'success' }),
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not queue a refresh', { tone: 'error' }),
  });

  return (
    <div className="space-y-4">
      {c.summary && (
        <Section title="Summary">
          <p className="text-sm leading-relaxed text-muted">{c.summary}</p>
          <p className="mt-1.5 text-2xs text-subtle">
            {/* Named explicitly: a recruiter should always know whether they
                are reading a model's inference or a computed heuristic. */}
            {c.summarySource === 'llm'
              ? 'Generated from their public profile and repositories.'
              : `Derived from profile signals (${c.summarySource}).`}
          </p>
        </Section>
      )}

      {c.bio && !c.summary && (
        <Section title="Bio">
          <p className="text-sm leading-relaxed text-muted">{c.bio}</p>
        </Section>
      )}

      <Section title="Signals">
        <div className="grid grid-cols-4 gap-3 rounded-lg border border-line bg-raised p-3">
          <Stat label="Stars" value={c.totalStars} />
          <Stat label="Followers" value={c.followers} />
          <Stat label="Repos" value={c.originalRepos} />
          <Stat label="Impact" value={c.impactScore} />
        </div>
        <div className="mt-3">
          <ActivityStrip signals={c.signals} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-2xs">
          <div className="flex justify-between gap-2">
            <dt className="text-subtle">Seniority</dt>
            <dd className="text-muted">{c.seniority ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-subtle">Active years</dt>
            <dd className="font-mono text-muted">{c.signals.activeYears}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-subtle">Last active</dt>
            <dd className="text-muted">{relativeTime(c.lastActiveAt)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-subtle">On GitHub since</dt>
            <dd className="text-muted">{formatDate(c.githubCreatedAt)}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Stack">
        <LanguageBars languages={c.languages} />
        {c.topics.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {c.topics.slice(0, 12).map((t) => (
              <span key={t} className="chip text-2xs">
                {t}
              </span>
            ))}
          </div>
        )}
      </Section>

      {c.lists.length > 0 && (
        <Section title="Pipelines">
          <ul className="space-y-1.5">
            {c.lists.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate font-medium">{l.list_name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="brand">{STAGE_LABELS[l.stage] ?? l.stage}</Badge>
                  <span className="text-2xs text-subtle">{relativeTime(l.added_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Tags">
        <div className="flex flex-wrap items-center gap-1.5">
          {c.tags.map((t) => (
            <span
              key={t.id}
              className="group inline-flex items-center overflow-hidden rounded-full border border-line bg-raised"
            >
              <span className="py-0.5 pl-2.5 pr-1 text-xs text-muted">{t.label}</span>
              {can('tag:write') && (
                <button
                  onClick={() => deleteTag.mutate(t.id)}
                  aria-label={`Remove tag ${t.label}`}
                  className="pr-2 pl-0.5 text-subtle hover:text-danger"
                >
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </span>
          ))}

          {can('tag:write') && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (tagDraft.trim()) addTag.mutate(tagDraft.trim());
              }}
            >
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                aria-label="Add a tag"
                placeholder="+ tag"
                className="w-20 rounded-full border border-dashed border-line bg-transparent px-2.5 py-0.5 text-xs
                           placeholder:text-subtle focus:w-32 focus:border-brand focus:outline-none"
              />
            </form>
          )}

          {!c.tags.length && !can('tag:write') && (
            <p className="text-xs text-subtle">No tags.</p>
          )}
        </div>
      </Section>

      <Section title={`Notes${c.notes.length ? ` (${c.notes.length})` : ''}`}>
        {can('note:write') && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (noteDraft.trim()) addNote.mutate(noteDraft.trim());
            }}
            className="mb-2.5"
          >
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                // Submit on modifier+Enter, so a plain Enter still adds a
                // newline in what is genuinely a multi-line field.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && noteDraft.trim()) {
                  e.preventDefault();
                  addNote.mutate(noteDraft.trim());
                }
              }}
              rows={2}
              aria-label="Add a note"
              placeholder="Add a note… (⌘/Ctrl + Enter to save)"
              className="input resize-y text-xs"
            />
            {noteDraft.trim() && (
              <div className="mt-1.5 flex justify-end">
                <button
                  type="submit"
                  disabled={addNote.isPending}
                  className={cn('btn-primary py-1.5 text-xs', addNote.isPending && 'opacity-70')}
                >
                  {addNote.isPending && <Spinner />}
                  Save note
                </button>
              </div>
            )}
          </form>
        )}

        {c.notes.length ? (
          <ul className="space-y-2">
            {c.notes.map((n) => (
              <li key={n.id} className="rounded-lg border border-line bg-raised px-3 py-2">
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">{n.body}</p>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-subtle">
                  <span>
                    {n.author_name ?? 'Someone'} · {relativeTime(n.created_at)}
                  </span>
                  {can('note:write') && (
                    <button
                      onClick={() => deleteNote.mutate(n.id)}
                      className="hover:text-danger hover:underline"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-subtle">
            No notes yet. Anything written here is visible to your whole workspace.
          </p>
        )}
      </Section>

      {c.repos.length > 0 && (
        <Section title={`Top repositories (${c.repos.length})`}>
          <ul className="space-y-1.5">
            {c.repos.slice(0, 8).map((r) => (
              <li key={r.name}>
                <a
                  href={r.html_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block rounded-lg border border-line px-3 py-2 transition hover:border-brand hover:bg-brand-soft/40"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium">{r.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-subtle">
                      ★ {compactNumber(r.stars)}
                    </span>
                  </div>
                  {r.description && (
                    <p className="mt-0.5 line-clamp-2 text-2xs text-muted">{r.description}</p>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-2xs text-subtle">
                    {r.language && <span>{r.language}</span>}
                    <span>Pushed {relativeTime(r.pushed_at)}</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Data">
        <dl className="space-y-1.5 text-2xs">
          <div className="flex justify-between gap-2">
            <dt className="text-subtle">Source</dt>
            <dd className="text-muted">
              {c.source === 'github' ? 'Fetched live from GitHub' : 'Indexed corpus'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-subtle">Profile fetched</dt>
            <dd className="text-muted">{relativeTime(c.fetchedAt)}</dd>
          </div>
        </dl>

        {can('candidate:scan') && (
          <button
            onClick={() => rescan.mutate()}
            disabled={rescan.isPending}
            className="btn-secondary mt-2.5 w-full py-1.5 text-xs"
          >
            {rescan.isPending && <Spinner />}
            Refresh from GitHub
          </button>
        )}
      </Section>
    </div>
  );
}
