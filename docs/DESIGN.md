# Design system

Referenced from `web/src/index.css` and `web/tailwind.config.js`.

## Tokens, not colours

Every colour is declared once per mode in `index.css` as an `R G B` triple, so
Tailwind's `<alpha-value>` syntax works (`bg-surface/60`). Components reference
*roles* — `surface`, `ink`, `line`, `muted`, `brand` — and never a raw hex.

The payoff is that dark mode is a change to one file rather than a `dark:`
variant on every element. Grep the components: there is no `dark:` prefix
anywhere.

| Role | Job |
|---|---|
| `canvas` | page background, behind cards |
| `surface` | card and panel background |
| `raised` | subtle fill inside a surface (column headers, chips) |
| `ink` | primary text |
| `muted` / `subtle` | secondary / tertiary text |
| `line` | borders and dividers |
| `brand` / `brand-soft` / `brand-ink` | interactive accent, its tint, text on it |
| `positive` / `warning` / `danger` | **status only** — never a chart series |

Dark is defined twice on purpose: once under `prefers-color-scheme: dark` and
once under an explicit `.dark` class, so a viewer's toggle wins in both
directions rather than only being able to follow the OS.

## Data visualisation palette

Chart series use `--series-1..3`, deliberately kept apart from `--brand` so a
rebrand cannot silently break a palette that was checked for colour-vision
separation.

| Slot | Light | Dark |
|---|---|---|
| `series-1` | `#2A78D6` | `#3987E5` |
| `series-2` | `#EB6834` | `#D95926` |
| `series-3` | `#1BAF7A` | `#199E70` |

The dark steps are **re-stepped against the dark surface**, not an automatic
flip of the light values.

### Validation

Both sets were checked with a palette validator rather than eyeballed:

```
light (surface #ffffff)          dark (surface #16171E)
[PASS] lightness band            [PASS] lightness band
[PASS] chroma floor              [PASS] chroma floor
[PASS] CVD separation  ΔE 9.2    [PASS] CVD separation  ΔE 9.4
[PASS] normal-vision   ΔE 27.6   [PASS] normal-vision   ΔE 26.5
[WARN] contrast vs surface       [PASS] contrast vs surface
```

The one warning is `#1BAF7A` at 2.74:1 against a white surface, which is below
3:1. That warning is **not dismissable** — it obliges visible relief, so every
chart in `components/charts.tsx` ships:

- a legend with visible text labels whenever there are two or more series, and
  none when there is one (the title names it);
- a **Data** toggle that reveals the underlying table.

Identity is therefore never carried by colour alone.

### Chart rules

- **One y-axis, ever.** Two measures of different scale get two charts. This is
  why search volume and p95 latency are separate panels on the analytics page
  rather than one dual-axis chart.
- **Colour follows the entity, not its rank** — filtering a series out never
  repaints the survivors.
- Categorical hues are assigned in fixed order and never cycled.
- Thin marks, 2px lines, ≥8px hover markers, 4px rounded bar ends anchored to
  the baseline, a 2px surface gap between adjacent bars, and a surface ring on
  overlapping markers so crossing series stay legible.
- Grid and axes are recessive; axis labels are thinned so they cannot collide.
- Every chart has a hover layer — crosshair plus tooltip on lines, per-mark
  tooltip on bars.
- Values, labels and legends wear text tokens, never the series colour.

Language colours are the exception to the series palette: they come from
`languageColor()` in `lib/format.ts`, which uses the recognisable GitHub colours
where they exist and a stable hash otherwise. Recruiters already read those
colours, and the same function is used by the result cards, the profile drawer
and the comparison table so a language never changes colour as you move through
the app.

## Accessibility commitments

These are constraints, not nice-to-haves:

- A skip link is the first thing in the tab order on every page.
- `:focus-visible` gives a visible ring on everything reachable by keyboard,
  without ringing every mouse click.
- Dialogs and the profile drawer trap focus while open and return it to whatever
  opened them.
- The results list is a `listbox` driven by `aria-activedescendant`, so arrow
  keys move one active option instead of putting thousands of rows in the tab
  order.
- Result counts and save confirmations are announced through a live region.
- Labels are real `<label>` elements; a placeholder is an example, never a
  substitute.
- Icon-only buttons carry `aria-label`, and toggles say what they *will do*
  rather than what they currently are.
- `prefers-reduced-motion` collapses every animation — nothing depends on motion
  to be understood.
- Wide tables and board columns scroll inside their own container, so the page
  body never scrolls sideways.

## Motion

Four keyframes only: `fade-in`, `slide-up`, `slide-in-right`, `shimmer`.
Durations sit between 150ms and 220ms on a `cubic-bezier(0.22, 1, 0.36, 1)`
ease-out, which is fast enough to feel like a response rather than an
animation.
