import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Dialog, Field, Spinner, useToast } from './ui';
import { cn } from '../lib/format';
import type { ListSummary, SaveableCandidate } from '../lib/types';

/**
 * Pipeline picker, shown only when there is an actual choice to make. With one
 * pipeline the caller saves directly - a dialog with a single option is a
 * speed bump, not a decision.
 */
export function SaveToPipeline({
  candidate,
  lists,
  onClose,
  onSave,
}: {
  candidate: SaveableCandidate;
  lists: ListSummary[];
  onClose: () => void;
  onSave: (listId: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const createList = useMutation({
    mutationFn: () => api.createList({ name: name.trim() }),
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: ['lists'] });
      onSave(list.id);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not create pipeline', { tone: 'error' }),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Save ${candidate.name || candidate.login}`}
      description="Pick a pipeline. The evidence that surfaced this candidate is saved with them."
      size="sm"
    >
      {!creating ? (
        <div className="space-y-2">
          <ul className="space-y-1.5">
            {lists.map((list) => (
              <li key={list.id}>
                <button
                  onClick={() => onSave(list.id)}
                  className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2.5 text-left text-sm transition hover:border-brand hover:bg-brand-soft"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{list.name}</span>
                    <span className="block text-2xs text-subtle">
                      {list.member_count} {list.member_count === 1 ? 'candidate' : 'candidates'}
                    </span>
                  </span>
                  {list.is_default && <span className="chip shrink-0">Default</span>}
                </button>
              </li>
            ))}
          </ul>

          <button
            onClick={() => setCreating(true)}
            className="w-full rounded-lg border border-dashed border-line px-3 py-2.5 text-sm text-muted transition hover:border-brand hover:text-brand"
          >
            + New pipeline
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createList.mutate();
          }}
          className="space-y-3"
        >
          <Field label="Pipeline name" hint="For example: Backend Platform Q1">
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
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreating(false)} className="btn-ghost">
              Back
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createList.isPending}
              className={cn('btn-primary', createList.isPending && 'opacity-70')}
            >
              {createList.isPending && <Spinner />}
              Create and save
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
