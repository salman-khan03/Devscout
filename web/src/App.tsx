import { lazy, Suspense, useState } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './lib/api';
import { SessionProvider, useSession } from './lib/session';
import { useTheme } from './hooks';
import { cn } from './lib/format';
import { Field, Spinner, ToastProvider, useToast } from './components/ui';
import { SearchPage } from './pages/SearchPage';
import type { Permission } from './lib/types';

/*
 * Routes are code-split apart from search. Search is what everyone lands on,
 * so it ships in the entry chunk; analytics and ops pull in heavier charting
 * and polling code that most sessions never open.
 */
const PipelinesPage = lazy(() => import('./pages/PipelinesPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const TeamPage = lazy(() => import('./pages/TeamPage'));
const OpsPage = lazy(() => import('./pages/OpsPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const PricingPage = lazy(() => import('./pages/PricingPage'));
const AuthPage = lazy(() => import('./pages/AuthPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means "sign in", a 403 means "your role cannot do this", and a
      // 402 means "your plan does not include this". None of the three becomes
      // true by asking again.
      retry: (count, error) =>
        !(
          error instanceof ApiError &&
          (error.isAuth || error.isPermission || error.isPlanLimit)
        ) &&
        count < 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/* ------------------------------------------------------------------- guards */

function Protected({
  children,
  permission,
}: {
  children: React.ReactNode;
  permission?: Permission;
}) {
  const { session, isReady, can } = useSession();
  const location = useLocation();

  if (!isReady) return <FullPageSpinner />;

  if (!session?.user) {
    // Remember where they were headed, so signing in lands them there rather
    // than dumping them on the home page.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  // A signed-in user with no workspace cannot do anything useful yet. This
  // happens if an org creation failed part-way, or an invite was revoked.
  if (!session.org) return <CreateWorkspace />;

  if (permission && !can(permission)) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-base font-semibold">Not available on your role</h1>
        <p className="mt-2 text-sm text-muted">
          This page needs the <code className="font-mono text-xs">{permission}</code> permission.
          Your role is {session.role}. An admin in your workspace can change that.
        </p>
        <Link to="/" className="btn-secondary mt-5">
          Back to search
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center text-sm text-muted" role="status">
      <span className="flex items-center gap-2">
        <Spinner />
        Loading
      </span>
    </div>
  );
}

/* ------------------------------------------------------- first-run workspace */

function CreateWorkspace() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => api.createOrg(name.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries();
      toast('Workspace created', { tone: 'success' });
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not create the workspace', { tone: 'error' }),
  });

  return (
    <div className="mx-auto max-w-sm px-4 py-20">
      <h1 className="text-base font-semibold">Name your workspace</h1>
      <p className="mt-1.5 text-sm text-muted">
        Pipelines, notes and saved searches all belong to a workspace, and you can invite your team
        into it.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="mt-5 space-y-3"
      >
        <Field label="Workspace name" hint="Usually your company or team name">
          {(props) => (
            <input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="input"
              placeholder="Northwind Talent"
            />
          )}
        </Field>
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="btn-primary w-full"
        >
          {create.isPending && <Spinner />}
          Create workspace
        </button>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------------- top nav */

const NAV: Array<{ to: string; label: string; permission?: Permission }> = [
  { to: '/', label: 'Search' },
  { to: '/pipelines', label: 'Pipelines', permission: 'list:read' },
  { to: '/analytics', label: 'Analytics', permission: 'analytics:read' },
  { to: '/team', label: 'Team', permission: 'member:read' },
  { to: '/ops', label: 'Ingestion', permission: 'ingest:enqueue' },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const order = ['light', 'dark', 'system'] as const;
  const next = order[(order.indexOf(theme) + 1) % order.length];

  return (
    <button
      onClick={() => setTheme(next)}
      className="btn-ghost p-1.5"
      // The label says what it will do, not what it currently is - a toggle
      // whose name is its state reads backwards to a screen reader.
      aria-label={`Switch to ${next} theme`}
      title={`Theme: ${theme}`}
    >
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.5 9.5A5.5 5.5 0 016.5 2.5a5.5 5.5 0 107 7z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ) : theme === 'light' ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="3" width="13" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5.5 13.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function WorkspaceMenu() {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useSession();
  const [open, setOpen] = useState(false);

  const switchOrg = useMutation({
    mutationFn: (orgId: string) => api.switchOrg(orgId),
    onSuccess: async () => {
      // Everything on screen is org-scoped, so the whole cache is stale.
      await qc.invalidateQueries();
      setOpen(false);
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not switch workspace', { tone: 'error' }),
  });

  const memberships = session?.memberships ?? [];
  const current = session?.org;
  if (!current) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex max-w-[190px] items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs transition hover:border-brand"
      >
        <span className="min-w-0 truncate font-medium">{current.name}</span>
        <span className="chip shrink-0 text-2xs">{current.planName}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-subtle">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          {/* Click-away layer. A bare document listener would also swallow the
              click that opened the menu. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-1.5 w-64 animate-slide-up rounded-xl border border-line bg-surface p-1.5 shadow-pop"
          >
            <p className="label px-2 py-1">Workspaces</p>
            {memberships.map((m) => (
              <button
                key={m.orgId}
                role="menuitem"
                onClick={() => (m.orgId === current.id ? setOpen(false) : switchOrg.mutate(m.orgId))}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-raised',
                  m.orgId === current.id && 'bg-brand-soft text-brand',
                )}
              >
                <span className="min-w-0 truncate font-medium">{m.name}</span>
                <span className="shrink-0 text-2xs text-subtle">{m.role}</span>
              </button>
            ))}

            <div className="my-1 border-t border-line" />
            <Link
              role="menuitem"
              to="/account"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-raised hover:text-ink"
            >
              Account settings
            </Link>
            <Link
              role="menuitem"
              to="/pricing"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-raised hover:text-ink"
            >
              Plans and billing
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function TopNav() {
  const { session, can } = useSession();
  const visible = NAV.filter((item) => !item.permission || can(item.permission));

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-2xs text-brand-ink">
            DS
          </span>
          <span className="text-sm">DevScout</span>
        </Link>

        <nav aria-label="Main" className="min-w-0 flex-1 overflow-x-auto">
          <ul className="flex items-center gap-0.5">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  // `end` on the root link only, so /pipelines/:id keeps the
                  // Pipelines tab active while / is not also highlighted.
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'block whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
                      isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-raised hover:text-ink',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          {session?.features.demoMode && (
            <span className="chip chip-active hidden text-2xs sm:inline-flex">Demo data</span>
          )}
          <ThemeToggle />
          <WorkspaceMenu />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------- shell */

function Shell() {
  const { session, isReady } = useSession();
  const signedIn = Boolean(session?.user);

  return (
    <>
      {/* First thing in the tab order: skips the nav straight to content. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {signedIn && session?.org && <TopNav />}

      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route
            path="/login"
            element={!isReady ? <FullPageSpinner /> : signedIn ? <Navigate to="/" replace /> : <AuthPage />}
          />

          <Route path="/" element={<Protected><SearchPage /></Protected>} />
          <Route
            path="/pipelines"
            element={<Protected permission="list:read"><PipelinesPage /></Protected>}
          />
          <Route
            path="/pipelines/:listId"
            element={<Protected permission="list:read"><PipelinesPage /></Protected>}
          />
          <Route
            path="/analytics"
            element={<Protected permission="analytics:read"><AnalyticsPage /></Protected>}
          />
          <Route
            path="/team"
            element={<Protected permission="member:read"><TeamPage /></Protected>}
          />
          <Route
            path="/ops"
            element={<Protected permission="ingest:enqueue"><OpsPage /></Protected>}
          />
          <Route path="/pricing" element={<Protected><PricingPage /></Protected>} />
          <Route path="/account" element={<Protected><AccountPage /></Protected>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Toasts sit outside the session provider so a session error can
            still be reported through them. */}
        <ToastProvider>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
