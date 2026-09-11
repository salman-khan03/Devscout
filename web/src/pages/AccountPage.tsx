import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useTheme } from '../hooks';
import { cn, formatDate } from '../lib/format';
import { Badge, Field, Spinner, useToast } from '../components/ui';

/**
 * Account settings: who you are, how you sign in, and what your workspace is
 * entitled to. Workspace-level settings live on the Team page - this page is
 * the things that belong to the person rather than the organisation.
 */
export default function AccountPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useSession();
  const { theme, setTheme } = useTheme();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);

  const changePassword = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setError(null);
      toast('Password changed', { tone: 'success' });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not change your password'),
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      // Clear every cached org-scoped query, or the next person to sign in on
      // this browser briefly sees the previous session's data.
      qc.clear();
      navigate('/login', { replace: true });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not sign out', { tone: 'error' }),
  });

  const user = session?.user;
  const org = session?.org;
  const limits = org?.limits;

  /** The plan limits express "no limit" as null. */
  const limitText = (value: number | null | undefined) =>
    value === null || value === undefined ? 'Unlimited' : value.toLocaleString('en');

  return (
    <main id="main" className="mx-auto max-w-[700px] px-4 py-5 sm:px-6 lg:px-8">
      <h1 className="mb-4 text-base font-semibold">Account</h1>

      <div className="space-y-4">
        {/* --------------------------------------------------------- profile */}
        <section className="card p-4">
          <h2 className="text-xs font-semibold">You</h2>
          <dl className="mt-3 space-y-2">
            <div className="flex justify-between gap-3 text-xs">
              <dt className="text-subtle">Name</dt>
              <dd className="text-ink">{user?.name ?? 'Not set'}</dd>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <dt className="text-subtle">Email</dt>
              <dd className="truncate text-ink">{user?.email}</dd>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <dt className="text-subtle">Role in {org?.name}</dt>
              <dd>
                <Badge tone={session?.role === 'owner' ? 'brand' : 'neutral'}>
                  {session?.role}
                </Badge>
              </dd>
            </div>
          </dl>
        </section>

        {/* ----------------------------------------------------------- theme */}
        <section className="card p-4">
          <h2 className="text-xs font-semibold">Appearance</h2>
          <p className="mt-0.5 text-2xs text-subtle">
            Stored in this browser only, so it does not follow you between devices.
          </p>

          <div
            className="mt-3 flex items-center gap-0.5 rounded-lg border border-line p-0.5"
            role="group"
            aria-label="Theme"
          >
            {(['light', 'dark', 'system'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                aria-pressed={theme === option}
                className={cn(
                  'flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition',
                  theme === option ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ plan usage */}
        {org && (
          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xs font-semibold">Workspace plan</h2>
                <p className="mt-0.5 text-2xs text-subtle">
                  {org.planName}
                  {org.subscriptionStatus === 'trialing' && ' · on trial'}
                  {org.currentPeriodEnd && ` · renews ${formatDate(org.currentPeriodEnd)}`}
                </p>
              </div>
              <Link to="/pricing" className="btn-secondary py-1.5 text-xs">
                See plans
              </Link>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              <div className="flex justify-between gap-2 text-2xs">
                <dt className="text-subtle">Searches / day</dt>
                <dd className="font-mono text-muted">{limitText(limits?.searchesPerDay)}</dd>
              </div>
              <div className="flex justify-between gap-2 text-2xs">
                <dt className="text-subtle">Scans / day</dt>
                <dd className="font-mono text-muted">{limitText(limits?.scansPerDay)}</dd>
              </div>
              <div className="flex justify-between gap-2 text-2xs">
                <dt className="text-subtle">Saved candidates</dt>
                <dd className="font-mono text-muted">{limitText(limits?.savedCandidates)}</dd>
              </div>
              <div className="flex justify-between gap-2 text-2xs">
                <dt className="text-subtle">Seats</dt>
                <dd className="font-mono text-muted">{limitText(limits?.seats)}</dd>
              </div>
              <div className="flex justify-between gap-2 text-2xs">
                <dt className="text-subtle">CSV export</dt>
                <dd className="text-muted">{limits?.csvExport ? 'Included' : 'Not included'}</dd>
              </div>
              <div className="flex justify-between gap-2 text-2xs">
                <dt className="text-subtle">Analytics</dt>
                <dd className="text-muted">{limits?.analytics ? 'Included' : 'Not included'}</dd>
              </div>
            </dl>

            {session?.usage && (
              <p className="mt-3 border-t border-line pt-2.5 text-2xs text-subtle">
                Today: {session.usage.searches} searches, {session.usage.profile_scans} scans,{' '}
                {session.usage.exports} exports.
              </p>
            )}
          </section>
        )}

        {/* -------------------------------------------------------- password */}
        <section className="card p-4">
          <h2 className="text-xs font-semibold">Change password</h2>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (current && next.length >= 8) changePassword.mutate();
            }}
            className="mt-3 space-y-3"
          >
            <Field label="Current password">
              {(props) => (
                <input
                  {...props}
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  className="input"
                />
              )}
            </Field>

            <Field
              label="New password"
              hint="At least 8 characters"
              error={error ?? undefined}
            >
              {(props) => (
                <input
                  {...props}
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  className="input"
                />
              )}
            </Field>

            <button
              type="submit"
              disabled={!current || next.length < 8 || changePassword.isPending}
              className="btn-primary"
            >
              {changePassword.isPending && <Spinner />}
              Change password
            </button>
          </form>
        </section>

        {/* ---------------------------------------------------------- signout */}
        <section className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <h2 className="text-xs font-semibold">Sign out</h2>
            <p className="mt-0.5 text-2xs text-subtle">
              Ends this session on this device.
              {session?.memberships.length
                ? ` You belong to ${session.memberships.length} workspace${
                    session.memberships.length === 1 ? '' : 's'
                  }.`
                : ''}
            </p>
          </div>
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="btn-secondary py-1.5 text-xs"
          >
            {logout.isPending && <Spinner />}
            Sign out
          </button>
        </section>
      </div>
    </main>
  );
}
