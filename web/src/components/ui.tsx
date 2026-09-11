import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/format';
import { useFocusTrap } from '../hooks';

/* ------------------------------------------------------------------ Spinner */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className ?? 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------- Badge */

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'positive' | 'warning' | 'danger';
  className?: string;
}) {
  const tones = {
    neutral: 'border-line bg-raised text-muted',
    brand: 'border-brand/30 bg-brand-soft text-brand',
    positive: 'border-positive/30 bg-positive/10 text-positive',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    danger: 'border-danger/30 bg-danger/10 text-danger',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- Dialog */

/**
 * Accessible modal.
 *
 * role="dialog" + aria-modal names it to assistive tech, focus is trapped
 * inside while open and returned to the trigger on close, Escape dismisses, and
 * the body stops scrolling so the page behind does not move under the overlay.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const trapRef = useFocusTrap(open);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-ink/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={trapRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          'relative z-10 max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-line',
          'bg-surface p-5 shadow-pop animate-slide-up sm:rounded-2xl',
          widths[size],
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          <button onClick={onClose} className="btn-ghost -mr-1 -mt-1 p-1.5" aria-label="Close dialog">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------- Toast */

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
}

const ToastCtx = createContext<{
  toast: (message: string, opts?: Partial<Omit<Toast, 'id' | 'message'>>) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback(
    (message: string, opts: Partial<Omit<Toast, 'id' | 'message'>> = {}) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, message, tone: opts.tone ?? 'info', action: opts.action }]);
      // Errors stay longer - they usually need reading, not just noticing.
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.tone === 'error' ? 6000 : 3500);
    },
    [],
  );

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {/*
        role="status" + aria-live="polite" so a screen reader hears the message
        without it interrupting whatever is being read.
      */}
      <div
        className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-pop animate-slide-up',
              t.tone === 'error'
                ? 'border-danger/30 bg-danger/10 text-danger'
                : t.tone === 'success'
                  ? 'border-positive/30 bg-positive/10 text-positive'
                  : 'border-line bg-surface text-ink',
            )}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                onClick={t.action.onClick}
                className="shrink-0 text-xs font-semibold underline underline-offset-2"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside a ToastProvider');
  return ctx.toast;
}

/* ------------------------------------------------------------- Empty states */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Loading placeholder shaped like the content it replaces. */
export function CardSkeleton() {
  return (
    <div className="card p-4" aria-hidden="true">
      <div className="flex gap-3">
        <div className="skeleton h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-3.5 w-1/3" />
          <div className="skeleton h-3 w-2/3" />
          <div className="flex gap-1.5 pt-1">
            <div className="skeleton h-4 w-14 rounded-full" />
            <div className="skeleton h-4 w-14 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ Errors & guardrails */

export function ErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
    >
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 font-semibold underline underline-offset-2">
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * What a 402 should look like.
 *
 * A plan limit is not a malfunction, so it does not get the red alert
 * treatment - it states what is missing and offers the one action that fixes
 * it. `ErrorNotice` is for things that went wrong.
 */
export function PlanLimitNotice({
  message,
  children,
}: {
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-brand/30 bg-brand-soft/50 px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{message}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** Labelled form field. The label is always real, never a placeholder. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy || undefined })}
      {hint && !error && (
        <p id={hintId} className="text-2xs text-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-2xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
