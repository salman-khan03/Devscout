import { compactNumber, languageColor } from '../lib/format';
import type { LanguageShare, Signals } from '../lib/types';

/**
 * The at-a-glance read on a candidate's profile.
 *
 * Colours come from `languageColor`, the same function the result cards use, so
 * Rust is the same orange in the list, the drawer and the comparison table. A
 * local palette here would have meant the same language changing colour as you
 * moved through the app.
 */

/** Stacked language share: proportion of their work, by repo weight. */
export function LanguageBars({ languages }: { languages: LanguageShare[] }) {
  if (!languages.length) {
    return <p className="text-xs text-subtle">No language data for this profile.</p>;
  }

  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-line/60"
        role="img"
        aria-label={languages.map((l) => `${l.language} ${l.pct}%`).join(', ')}
      >
        {languages.map((l) => (
          <div
            key={l.language}
            style={{ width: `${l.pct}%`, background: languageColor(l.language) }}
            title={`${l.language} · ${l.pct}% · ${l.repos} repos`}
          />
        ))}
      </div>

      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {languages.map((l) => (
          <li key={l.language} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: languageColor(l.language) }}
              aria-hidden="true"
            />
            <span className="font-medium">{l.language}</span>
            <span className="font-mono text-2xs text-subtle">{l.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Recent-activity density strip.
 *
 * Twelve cells, one lit per repo pushed in the last 90 days. It is a shape
 * rather than a number because "is this person still writing code" is the
 * question, and a filled-or-not strip answers it before you read the caption.
 */
export function ActivityStrip({ signals }: { signals: Signals }) {
  const cells = 12;
  const active = Math.min(signals.recentPushes, cells);

  return (
    <div>
      <div
        className="flex gap-1"
        role="img"
        aria-label={`${signals.recentPushes} repositories pushed in the last 90 days`}
      >
        {Array.from({ length: cells }, (_, i) => {
          const lit = i < active;
          return (
            <span
              key={i}
              className={lit ? 'h-3.5 flex-1 rounded-sm bg-positive' : 'h-3.5 flex-1 rounded-sm bg-line/70'}
              // Ramping opacity across the lit cells reads as intensity
              // without introducing a second colour.
              style={lit ? { opacity: 0.4 + (i / cells) * 0.6 } : undefined}
            />
          );
        })}
      </div>

      <div className="mt-1.5 flex justify-between text-2xs text-subtle">
        <span>Recent activity</span>
        <span className="font-mono">{signals.recentPushes} pushes / 90d</span>
      </div>
    </div>
  );
}

/** A single figure with its label. */
export function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-base font-medium leading-none text-ink">
        {typeof value === 'number' ? compactNumber(value) : value}
      </span>
      <span className="mt-1 text-2xs uppercase tracking-wide text-subtle">{label}</span>
    </div>
  );
}
