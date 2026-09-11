/** Formatting helpers. Centralised so the same number never renders two ways. */

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en');

/** 1234 -> "1.2k". For dense UI where the exact figure is not the point. */
export const compactNumber = (n: number | null | undefined): string =>
  n === null || n === undefined ? '-' : n < 1000 ? plain.format(n) : compact.format(n);

export const fullNumber = (n: number | null | undefined): string =>
  n === null || n === undefined ? '-' : plain.format(n);

/** "3 days ago". Absolute dates are unreadable at a glance in a feed. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, secondsPer] of units) {
    if (Math.abs(seconds) >= secondsPer) {
      return rtf.format(-Math.round(seconds / secondsPer), unit);
    }
  }
  return 'just now';
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Conditional className joiner. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Deterministic colour for a language chip.
 *
 * Uses the real GitHub colours where they are well known, because recruiters
 * recognise them, and falls back to a hash so an unlisted language still gets a
 * stable colour rather than changing between renders.
 */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  PHP: '#4F5D95',
  Scala: '#c22d40',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Dart: '#00B4AB',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Lua: '#000080',
  Perl: '#0298c3',
  R: '#198CE7',
  Zig: '#ec915c',
  HCL: '#844FBA',
  SQL: '#e38c00',
  Cuda: '#3A4E3A',
  'Jupyter Notebook': '#DA5B0B',
  Makefile: '#427819',
  'Objective-C': '#438eff',
};

export function languageColor(language: string): string {
  const known = LANGUAGE_COLORS[language];
  if (known) return known;

  let hash = 0;
  for (let i = 0; i < language.length; i++) {
    hash = (hash << 5) - hash + language.charCodeAt(i);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360} 55% 50%)`;
}

export const STAGE_LABELS: Record<string, string> = {
  sourced: 'Sourced',
  contacted: 'Contacted',
  screening: 'Screening',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Passed',
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  viewer: 'Read-only. Can search and view candidates.',
  recruiter: 'Can edit pipelines, notes, tags and saved searches.',
  admin: 'Can manage members, invitations and ingestion.',
  owner: 'Full control including billing.',
};

/** Triggers a browser download for a Blob the app already holds. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
