import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Delays a value until it stops changing.
 *
 * Used for the search box: without it every keystroke is a request, and the
 * responses race - a slow reply for "ru" can land after a fast reply for
 * "rust" and overwrite the newer results with older ones.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}

/** Tracks a CSS media query, for layout decisions React has to make in JS. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * Announces a message to assistive technology.
 *
 * Search results updating, a candidate being saved, a filter being applied -
 * all of these are obvious to a sighted user and completely silent to a screen
 * reader without a live region. The message is cleared and re-set so repeating
 * the same text still announces.
 */
export function useAnnouncer() {
  const [message, setMessage] = useState('');

  const announce = useCallback((text: string) => {
    setMessage('');
    // A frame apart, so the region content genuinely changes.
    requestAnimationFrame(() => setMessage(text));
  }, []);

  return { message, announce };
}

export interface Hotkey {
  /** Single key, or a combination: "mod+k", "shift+?", "escape". */
  combo: string;
  handler: (e: KeyboardEvent) => void;
  /** Allow the key to fire while an input has focus. Off by default. */
  allowInInput?: boolean;
  description?: string;
}

function matches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const wantMod = parts.includes('mod');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt');

  // "mod" is Command on macOS and Control elsewhere - matching the platform
  // convention rather than forcing Control on Mac users.
  const modPressed = e.metaKey || e.ctrlKey;

  if (wantMod !== modPressed) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;

  return e.key.toLowerCase() === key;
}

const isEditable = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
  );
};

/** Registers global keyboard shortcuts. */
export function useHotkeys(hotkeys: Hotkey[], enabled = true) {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      for (const hk of ref.current) {
        if (!hk.allowInInput && isEditable(e.target)) continue;
        if (!matches(e, hk.combo)) continue;
        e.preventDefault();
        hk.handler(e);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/**
 * Roving focus over a list.
 *
 * Arrow keys move a single "active" index rather than moving DOM focus through
 * every row, which is what keeps a 10,000-row virtualised list navigable: only
 * the active row is rendered as focusable, so the tab order stays one stop
 * instead of ten thousand.
 */
export function useListNavigation<T>(
  items: T[],
  opts: { onSelect?: (item: T, index: number) => void; enabled?: boolean } = {},
) {
  const [index, setIndex] = useState(-1);
  const { onSelect, enabled = true } = opts;

  // Reset when the list itself changes, so the cursor cannot point past the end.
  useEffect(() => {
    setIndex((i) => (i >= items.length ? Math.max(items.length - 1, -1) : i));
  }, [items.length]);

  const move = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = i + delta;
        if (next < 0) return 0;
        if (next >= items.length) return items.length - 1;
        return next;
      });
    },
    [items.length],
  );

  useHotkeys(
    [
      { combo: 'j', handler: () => move(1), description: 'Next result' },
      { combo: 'arrowdown', handler: () => move(1), description: 'Next result' },
      { combo: 'k', handler: () => move(-1), description: 'Previous result' },
      { combo: 'arrowup', handler: () => move(-1), description: 'Previous result' },
      {
        combo: 'enter',
        handler: () => {
          if (index >= 0 && items[index]) onSelect?.(items[index], index);
        },
        description: 'Open the highlighted result',
      },
    ],
    enabled,
  );

  return { index, setIndex, move };
}

/**
 * Traps focus inside a container while it is open, and restores focus to
 * whatever opened it on close.
 *
 * Without this a keyboard user tabs straight out of an open dialog and into the
 * page behind it, with no visible indication of where they have gone.
 */
export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    previouslyFocused.current = document.activeElement as HTMLElement;
    const container = containerRef.current;
    if (!container) return;

    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const focusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null,
      );

    // Move focus in, so the first Tab lands inside rather than after.
    focusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [active]);

  return containerRef;
}

/** Per-viewer preference with a safe fallback when storage is unavailable. */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      // Private browsing, disabled site data, or a quota error. Not fatal.
      return initial;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* preference simply will not persist */
      }
    },
    [key],
  );

  return [value, set] as const;
}

/** Calls `onIntersect` when the sentinel scrolls into view. Infinite scroll. */
export function useIntersection(
  onIntersect: () => void,
  opts: { enabled?: boolean; rootMargin?: string } = {},
) {
  const { enabled = true, rootMargin = '400px' } = opts;
  const ref = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onIntersect);
  callback.current = onIntersect;

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) callback.current();
      },
      // Fires before the sentinel is visible, so the next page is already
      // loading by the time the user reaches the bottom.
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return ref;
}

/** Theme with three states: explicit light, explicit dark, or follow the OS. */
export type Theme = 'light' | 'dark' | 'system';

export function useTheme() {
  const [theme, setThemeState] = useLocalStorage<Theme>('devscout:theme', 'system');

  const resolved = useMemo(() => {
    if (theme !== 'system') return theme;
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }, [theme]);

  useEffect(() => {
    const apply = () => {
      const isDark =
        theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', isDark);
    };

    apply();

    // Only follow the OS while the user has not made an explicit choice.
    if (theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [theme]);

  return { theme, resolved, setTheme: setThemeState };
}
