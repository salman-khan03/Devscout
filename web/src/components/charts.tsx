import { useMemo, useRef, useState } from 'react';
import { cn, compactNumber } from '../lib/format';

/**
 * Chart primitives.
 *
 * Inline SVG rather than a charting library: these are three chart types over
 * small, known-shaped series, and a library would cost more bundle than the
 * whole analytics page.
 *
 * COLOUR. Series use the `--series-*` tokens, which are a separate, validated
 * set from the brand colour - three hues stepped for colour-vision separation
 * and re-stepped for the dark surface rather than flipped. Colour is assigned
 * by series identity in fixed order and never by rank, so filtering one series
 * out does not repaint the others.
 *
 * RELIEF. The light-mode green sits under 3:1 against the surface, so every
 * chart here ships a legend with visible labels and a table view. Identity is
 * never carried by colour alone.
 */

const SERIES = ['rgb(var(--series-1))', 'rgb(var(--series-2))', 'rgb(var(--series-3))'] as const;

export interface Series {
  key: string;
  label: string;
  values: number[];
}

/* ---------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: 'text-ink',
    positive: 'text-positive',
    warning: 'text-warning',
    danger: 'text-danger',
  };

  return (
    <div className="card p-3.5">
      <p className="label">{label}</p>
      <p className={cn('mt-1.5 font-mono text-xl font-semibold leading-none', tones[tone])}>
        {typeof value === 'number' ? compactNumber(value) : value}
      </p>
      {hint && <p className="mt-1.5 text-2xs text-subtle">{hint}</p>}
    </div>
  );
}

/* -------------------------------------------------------------- table relief */

function DataTable({
  labels,
  series,
  labelHeader,
}: {
  labels: string[];
  series: Series[];
  labelHeader: string;
}) {
  return (
    <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-2xs">
        <thead className="sticky top-0 bg-raised">
          <tr>
            <th scope="col" className="px-2.5 py-1.5 text-left font-semibold">
              {labelHeader}
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-2.5 py-1.5 text-right font-semibold">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {labels.map((label, i) => (
            <tr key={label + i}>
              <th scope="row" className="px-2.5 py-1.5 text-left font-normal text-muted">
                {label}
              </th>
              {series.map((s) => (
                <td key={s.key} className="px-2.5 py-1.5 text-right font-mono text-muted">
                  {compactNumber(s.values[i] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartFrame({
  title,
  subtitle,
  labels,
  series,
  labelHeader,
  children,
}: {
  title: string;
  subtitle?: string;
  labels: string[];
  series: Series[];
  labelHeader: string;
  children: React.ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <figure className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <figcaption className="text-xs font-semibold">{title}</figcaption>
          {subtitle && <p className="mt-0.5 text-2xs text-subtle">{subtitle}</p>}
        </div>

        <div className="flex items-center gap-2">
          {/* A legend is always present once there are two series, and the
              labels are visible text rather than a colour key alone. */}
          {series.length > 1 && (
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {series.map((s, i) => (
                <li key={s.key} className="flex items-center gap-1.5 text-2xs text-muted">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: SERIES[i % SERIES.length] }}
                    aria-hidden="true"
                  />
                  {s.label}
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() => setShowTable((t) => !t)}
            aria-expanded={showTable}
            className="shrink-0 text-2xs text-subtle underline underline-offset-2 hover:text-brand"
          >
            {showTable ? 'Hide data' : 'Data'}
          </button>
        </div>
      </div>

      <div className="mt-3">{children}</div>

      {showTable && <DataTable labels={labels} series={series} labelHeader={labelHeader} />}
    </figure>
  );
}

/* ----------------------------------------------------------------- geometry */

const W = 720;
const H = 200;
const PAD = { top: 10, right: 10, bottom: 22, left: 38 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** A y-axis maximum that lands on a round number, so gridlines read cleanly. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Maps a pointer event to the nearest data index, accounting for SVG scaling. */
function indexFromPointer(
  e: React.PointerEvent<SVGSVGElement>,
  count: number,
): number | null {
  if (count === 0) return null;
  const rect = e.currentTarget.getBoundingClientRect();
  // The SVG is width:100% over a fixed viewBox, so client pixels must be
  // scaled back into viewBox units before comparing against the plot area.
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const ratio = (x - PAD.left) / PLOT_W;
  if (ratio < -0.05 || ratio > 1.05) return null;
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

function Gridlines({ max }: { max: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <g aria-hidden="true">
      {ticks.map((t) => {
        const y = PAD.top + PLOT_H * (1 - t);
        return (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              stroke="rgb(var(--line))"
              strokeWidth="1"
              // Recessive: the grid orients, it does not compete with the data.
              opacity={t === 0 ? 1 : 0.55}
            />
            <text
              x={PAD.left - 6}
              y={y + 3}
              textAnchor="end"
              className="fill-[rgb(var(--subtle))] font-mono"
              fontSize="9"
            >
              {compactNumber(Math.round(max * t))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/* ------------------------------------------------------------- line chart */

export function TimeSeriesChart({
  title,
  subtitle,
  labels,
  series,
  labelHeader = 'Day',
}: {
  title: string;
  subtitle?: string;
  labels: string[];
  series: Series[];
  labelHeader?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const max = useMemo(
    () => niceMax(Math.max(1, ...series.flatMap((s) => s.values))),
    [series],
  );

  const count = labels.length;
  const xAt = (i: number) => PAD.left + (count <= 1 ? PLOT_W / 2 : (PLOT_W * i) / (count - 1));
  const yAt = (v: number) => PAD.top + PLOT_H * (1 - v / max);

  if (!count) {
    return (
      <ChartFrame title={title} subtitle={subtitle} labels={labels} series={series} labelHeader={labelHeader}>
        <p className="py-10 text-center text-xs text-subtle">No activity in this window yet.</p>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame title={title} subtitle={subtitle} labels={labels} series={series} labelHeader={labelHeader}>
      <div ref={wrapRef} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          className="block touch-none"
          role="img"
          aria-label={`${title}. ${series
            .map((s) => `${s.label}: ${s.values.reduce((a, b) => a + b, 0)} total`)
            .join('. ')}`}
          onPointerMove={(e) => setHover(indexFromPointer(e, count))}
          onPointerLeave={() => setHover(null)}
        >
          <Gridlines max={max} />

          {/* x labels, thinned so they never collide */}
          <g aria-hidden="true">
            {labels.map((label, i) => {
              const every = Math.max(1, Math.ceil(count / 7));
              if (i % every !== 0 && i !== count - 1) return null;
              return (
                <text
                  key={i}
                  x={xAt(i)}
                  y={H - 6}
                  textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
                  className="fill-[rgb(var(--subtle))]"
                  fontSize="9"
                >
                  {label}
                </text>
              );
            })}
          </g>

          {hover !== null && (
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="rgb(var(--subtle))"
              strokeWidth="1"
              strokeDasharray="3 3"
              aria-hidden="true"
            />
          )}

          {series.map((s, si) => {
            const color = SERIES[si % SERIES.length];
            const d = s.values
              .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(v)}`)
              .join(' ');

            return (
              <g key={s.key}>
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* A single point would otherwise render as an invisible
                    zero-length path. */}
                {count === 1 && <circle cx={xAt(0)} cy={yAt(s.values[0] ?? 0)} r="4" fill={color} />}

                {hover !== null && (
                  <circle
                    cx={xAt(hover)}
                    cy={yAt(s.values[hover] ?? 0)}
                    r="4"
                    fill={color}
                    // A surface ring keeps overlapping markers legible where
                    // two series cross.
                    stroke="rgb(var(--surface))"
                    strokeWidth="2"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max max-w-[200px] rounded-lg border border-line bg-surface px-2.5 py-2 shadow-pop"
            style={{
              // Flip the tooltip to the left of the crosshair past halfway, so
              // it never runs off the right edge.
              left: `${(xAt(hover) / W) * 100}%`,
              transform: hover > count / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
            role="status"
          >
            <p className="text-2xs font-semibold">{labels[hover]}</p>
            <ul className="mt-1 space-y-0.5">
              {series.map((s, si) => (
                <li key={s.key} className="flex items-center justify-between gap-3 text-2xs">
                  <span className="flex items-center gap-1.5 text-muted">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: SERIES[si % SERIES.length] }}
                      aria-hidden="true"
                    />
                    {s.label}
                  </span>
                  <span className="font-mono text-ink">{compactNumber(s.values[hover] ?? 0)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------- bar chart */

export function BarChart({
  title,
  subtitle,
  labels,
  series,
  labelHeader = 'Day',
}: {
  title: string;
  subtitle?: string;
  labels: string[];
  series: Series;
  labelHeader?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => niceMax(Math.max(1, ...series.values)), [series.values]);
  const count = labels.length;

  if (!count) {
    return (
      <ChartFrame title={title} subtitle={subtitle} labels={labels} series={[series]} labelHeader={labelHeader}>
        <p className="py-10 text-center text-xs text-subtle">No data in this window yet.</p>
      </ChartFrame>
    );
  }

  // A 2px surface gap between adjacent bars, so they read as separate marks.
  const band = PLOT_W / count;
  const barW = Math.max(2, band - 2);

  return (
    <ChartFrame title={title} subtitle={subtitle} labels={labels} series={[series]} labelHeader={labelHeader}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          className="block touch-none"
          role="img"
          aria-label={`${title}. ${series.label}, ${series.values.reduce((a, b) => a + b, 0)} in total.`}
          onPointerMove={(e) => setHover(indexFromPointer(e, count))}
          onPointerLeave={() => setHover(null)}
        >
          <Gridlines max={max} />

          {series.values.map((v, i) => {
            const h = (v / max) * PLOT_H;
            const x = PAD.left + band * i + (band - barW) / 2;
            return (
              <rect
                key={i}
                x={x}
                // Bars are anchored to the baseline with rounded data-ends.
                y={PAD.top + PLOT_H - h}
                width={barW}
                height={Math.max(h, v > 0 ? 1.5 : 0)}
                rx={Math.min(4, barW / 2)}
                fill={SERIES[0]}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
            );
          })}

          <g aria-hidden="true">
            {labels.map((label, i) => {
              const every = Math.max(1, Math.ceil(count / 7));
              if (i % every !== 0 && i !== count - 1) return null;
              return (
                <text
                  key={i}
                  x={PAD.left + band * i + band / 2}
                  y={H - 6}
                  textAnchor="middle"
                  className="fill-[rgb(var(--subtle))]"
                  fontSize="9"
                >
                  {label}
                </text>
              );
            })}
          </g>
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-pop"
            style={{
              left: `${((PAD.left + band * hover + band / 2) / W) * 100}%`,
              transform: hover > count / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
            }}
            role="status"
          >
            <p className="text-2xs font-semibold">{labels[hover]}</p>
            <p className="text-2xs text-muted">
              <span className="font-mono text-ink">{compactNumber(series.values[hover] ?? 0)}</span>{' '}
              {series.label.toLowerCase()}
            </p>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/* ------------------------------------------------------- horizontal bars */

/**
 * Ranked magnitude with a category per row.
 *
 * Horizontal because the labels are words: vertical bars would force them to
 * rotate, and a rotated label is slower to read than a longer chart.
 */
export function RankedBars({
  title,
  subtitle,
  rows,
  emptyMessage = 'Nothing to show yet.',
}: {
  title: string;
  subtitle?: string;
  rows: Array<{ label: string; value: number }>;
  emptyMessage?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <figure className="card p-4">
      <figcaption className="text-xs font-semibold">{title}</figcaption>
      {subtitle && <p className="mt-0.5 text-2xs text-subtle">{subtitle}</p>}

      {!rows.length ? (
        <p className="py-8 text-center text-xs text-subtle">{emptyMessage}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2.5">
              <span className="truncate text-2xs text-muted" title={row.label}>
                {row.label}
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-line/50">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(row.value / max) * 100}%`, background: SERIES[0] }}
                />
              </span>
              {/* Direct label on every row: this is a short ranked list, so
                  the value belongs next to the bar rather than on a hover. */}
              <span className="font-mono text-2xs text-ink">{compactNumber(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
