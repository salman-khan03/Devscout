import { useState } from 'react';
import { cn, compactNumber } from '../lib/format';
import { Badge } from './ui';
import type { Facets, Filters, RankMode } from '../lib/types';

/**
 * Filter sidebar.
 *
 * Every control writes straight to the URL through `onChange`, so there is no
 * second copy of filter state to keep in sync - the URL is the state. Facet
 * counts come from the same filtered pool as the results, so the number beside
 * an option is what selecting it would actually return.
 */
interface Props {
  filters: Filters;
  facets?: Facets;
  activeCount: number;
  onChange: (next: Partial<Filters>) => void;
  onToggle: (key: 'languages' | 'topics' | 'locations' | 'seniority', value: string) => void;
  onClear: () => void;
}

const MODES: Array<{ id: RankMode; label: string; help: string }> = [
  {
    id: 'hybrid',
    label: 'Hybrid',
    help: 'Fuses keyword, semantic and activity ranking. Best general choice.',
  },
  {
    id: 'vector',
    label: 'Semantic',
    help: 'Matches meaning. Finds people who describe the work differently.',
  },
  {
    id: 'lexical',
    label: 'Keyword',
    help: 'Exact terms only. Precise, but misses any phrasing not literally present.',
  },
  {
    id: 'signal',
    label: 'Activity',
    help: 'Ignores the query. Ranks purely by recent output and impact.',
  },
];

const ACTIVITY_WINDOWS = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 3 months' },
  { days: 365, label: 'Last year' },
];

function Section({
  title,
  children,
  defaultOpen = true,
  count,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-line py-3 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="label">
          {title}
          {count ? <span className="ml-1.5 text-brand">{count}</span> : null}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          className={cn('text-subtle transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && <div className="mt-2.5 space-y-1.5">{children}</div>}
    </div>
  );
}

/** A facet option. The count is part of the label so it is read aloud too. */
function FacetOption({
  label,
  count,
  checked,
  onChange,
  swatch,
}: {
  label: string;
  count?: number;
  checked: boolean;
  onChange: () => void;
  swatch?: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition',
        checked ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-raised',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 shrink-0 rounded border-line text-brand focus:ring-brand/30"
      />
      {swatch && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: swatch }}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-2xs text-subtle">{compactNumber(count)}</span>}
    </label>
  );
}

export function FilterPanel({ filters, facets, activeCount, onChange, onToggle, onClear }: Props) {
  const [locationDraft, setLocationDraft] = useState('');

  const addLocation = () => {
    const value = locationDraft.trim();
    if (!value) return;
    if (!filters.locations.includes(value)) onChange({ locations: [...filters.locations, value] });
    setLocationDraft('');
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between pb-2">
        <h2 className="text-sm font-semibold">Filters</h2>
        {activeCount > 0 && (
          <button onClick={onClear} className="text-2xs font-medium text-brand hover:underline">
            Clear {activeCount}
          </button>
        )}
      </div>

      {/*
        Ranking mode is exposed to the user, not hidden as an implementation
        detail. It is the fastest way to understand why a result appeared, and
        the evaluation harness measures each of these modes directly.
      */}
      <Section title="Ranking">
        <div role="radiogroup" aria-label="Ranking mode" className="space-y-1">
          {MODES.map((m) => (
            <label
              key={m.id}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition',
                filters.mode === m.id ? 'bg-brand-soft' : 'hover:bg-raised',
              )}
            >
              <input
                type="radio"
                name="mode"
                checked={filters.mode === m.id}
                onChange={() => onChange({ mode: m.id })}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 border-line text-brand focus:ring-brand/30"
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    'block text-xs font-medium',
                    filters.mode === m.id ? 'text-brand' : 'text-ink',
                  )}
                >
                  {m.label}
                </span>
                <span className="block text-2xs leading-snug text-subtle">{m.help}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Language" count={filters.languages.length}>
        {facets?.languages.length ? (
          <div className="max-h-56 overflow-y-auto pr-1">
            {facets.languages.map((f) => (
              <FacetOption
                key={f.value}
                label={f.value}
                count={f.count}
                checked={filters.languages.includes(f.value)}
                onChange={() => onToggle('languages', f.value)}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 text-2xs text-subtle">No languages in the current result set.</p>
        )}
      </Section>

      <Section title="Topics" count={filters.topics.length} defaultOpen={false}>
        {facets?.topics.length ? (
          <div className="max-h-56 overflow-y-auto pr-1">
            {facets.topics.map((f) => (
              <FacetOption
                key={f.value}
                label={f.value}
                count={f.count}
                checked={filters.topics.includes(f.value)}
                onChange={() => onToggle('topics', f.value)}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 text-2xs text-subtle">No topics in the current result set.</p>
        )}
      </Section>

      <Section title="Seniority" count={filters.seniority.length}>
        {(facets?.seniority.length
          ? facets.seniority
          : [
              { value: 'Early-career', count: 0 },
              { value: 'Mid-level', count: 0 },
              { value: 'Senior', count: 0 },
              { value: 'Staff+', count: 0 },
            ]
        ).map((f) => (
          <FacetOption
            key={f.value}
            label={f.value}
            count={f.count || undefined}
            checked={filters.seniority.includes(f.value)}
            onChange={() => onToggle('seniority', f.value)}
          />
        ))}
        <p className="px-2 pt-1 text-2xs text-subtle">
          Derived from account age and sustained output. A hint, not a judgement.
        </p>
      </Section>

      <Section title="Location" count={filters.locations.length} defaultOpen={false}>
        <div className="flex gap-1.5">
          <input
            value={locationDraft}
            onChange={(e) => setLocationDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLocation();
              }
            }}
            placeholder="Berlin, remote, TX"
            aria-label="Add a location filter"
            className="input py-1.5 text-xs"
          />
          <button onClick={addLocation} className="btn-secondary shrink-0 px-2.5 py-1.5 text-xs">
            Add
          </button>
        </div>
        {filters.locations.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {filters.locations.map((loc) => (
              <button
                key={loc}
                onClick={() => onToggle('locations', loc)}
                className="chip chip-active gap-1.5"
                aria-label={`Remove location filter ${loc}`}
              >
                {loc}
                <span aria-hidden="true">x</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Activity" defaultOpen={false}>
        <div role="radiogroup" aria-label="Active within">
          <FacetOption
            label="Any time"
            checked={filters.activeWithinDays === undefined}
            onChange={() => onChange({ activeWithinDays: undefined })}
          />
          {ACTIVITY_WINDOWS.map((w) => (
            <FacetOption
              key={w.days}
              label={w.label}
              checked={filters.activeWithinDays === w.days}
              onChange={() => onChange({ activeWithinDays: w.days })}
            />
          ))}
        </div>
      </Section>

      <Section title="Thresholds" defaultOpen={false}>
        {(
          [
            { key: 'minStars', label: 'Minimum stars', placeholder: '100' },
            { key: 'minFollowers', label: 'Minimum followers', placeholder: '50' },
            { key: 'minRepos', label: 'Minimum original repos', placeholder: '5' },
          ] as const
        ).map((f) => (
          <label key={f.key} className="block px-2">
            <span className="mb-1 block text-2xs text-muted">{f.label}</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              value={filters[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) =>
                onChange({ [f.key]: e.target.value === '' ? undefined : Number(e.target.value) })
              }
              className="input py-1.5 text-xs"
            />
          </label>
        ))}
      </Section>

      <Section title="Pipeline" defaultOpen={false}>
        <FacetOption
          label="Hide candidates we already saved"
          checked={filters.excludeSaved === true}
          onChange={() =>
            onChange({ excludeSaved: filters.excludeSaved ? undefined : true, savedOnly: undefined })
          }
        />
        <FacetOption
          label="Only candidates we saved"
          checked={filters.savedOnly === true}
          onChange={() =>
            onChange({ savedOnly: filters.savedOnly ? undefined : true, excludeSaved: undefined })
          }
        />
        <FacetOption
          label="Open to work on GitHub"
          checked={filters.hireable === true}
          onChange={() => onChange({ hireable: filters.hireable ? undefined : true })}
        />
      </Section>

      {facets && (
        <p className="pt-3 text-2xs text-subtle">
          <Badge>{compactNumber(facets.total)}</Badge> candidates match the current filters.
        </p>
      )}
    </div>
  );
}
