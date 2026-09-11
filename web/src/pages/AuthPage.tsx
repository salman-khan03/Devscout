import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Field, Spinner } from '../components/ui';
import { cn } from '../lib/format';

/**
 * Sign in / sign up.
 *
 * One form, two modes, because the fields barely differ and a separate page
 * per mode doubles the surface for no gain. An `?invite=` token in the URL
 * switches the copy and skips the workspace-name field - someone joining a
 * team is not creating one.
 */
export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [params] = useSearchParams();

  const inviteToken = params.get('invite');
  const [mode, setMode] = useState<'login' | 'register'>(inviteToken ? 'register' : 'login');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Where to land after signing in - back to whatever they asked for. */
  const destination = (location.state as { from?: string } | null)?.from ?? '/';

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'login') {
        await api.login(email.trim(), password);
      } else {
        await api.register({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
          // A workspace name is only meaningful when creating one.
          orgName: inviteToken ? undefined : orgName.trim() || undefined,
          inviteToken: inviteToken ?? undefined,
        });
      }
    },
    onSuccess: async () => {
      // The session query is the app's source of truth for who you are, so it
      // is refetched rather than patched from the login response.
      await qc.invalidateQueries();
      navigate(destination, { replace: true });
    },
    onError: (e) => {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Something went wrong. Try again.',
      );
    },
  });

  const isRegister = mode === 'register';
  const canSubmit = email.trim().length > 3 && password.length >= 8 && !submit.isPending;

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <div className="mb-6">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-xs font-semibold text-brand-ink">
          DS
        </span>
        <h1 className="mt-4 text-lg font-semibold">
          {inviteToken
            ? 'Join your team on DevScout'
            : isRegister
              ? 'Create your DevScout workspace'
              : 'Sign in to DevScout'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {inviteToken
            ? 'Set a password to accept your invitation.'
            : 'Search GitHub for engineers by the work they have actually shipped.'}
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (canSubmit) submit.mutate();
        }}
        className="space-y-3"
        noValidate
      >
        {isRegister && (
          <Field label="Your name" hint="Optional - shown on notes you write">
            {(props) => (
              <input
                {...props}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                className="input"
                placeholder="Jordan Lee"
              />
            )}
          </Field>
        )}

        <Field label="Work email">
          {(props) => (
            <input
              {...props}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus
              className="input"
              placeholder="you@company.com"
            />
          )}
        </Field>

        <Field
          label="Password"
          hint={isRegister ? 'At least 8 characters' : undefined}
          error={error ?? undefined}
        >
          {(props) => (
            <input
              {...props}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // Tells the password manager whether to offer a saved password
              // or generate a new one.
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              minLength={8}
              className="input"
            />
          )}
        </Field>

        {isRegister && !inviteToken && (
          <Field label="Workspace name" hint="Your company or team. You can invite people later.">
            {(props) => (
              <input
                {...props}
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                className="input"
                placeholder="Northwind Talent"
              />
            )}
          </Field>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={cn('btn-primary w-full', submit.isPending && 'opacity-70')}
        >
          {submit.isPending && <Spinner />}
          {inviteToken ? 'Accept invitation' : isRegister ? 'Create workspace' : 'Sign in'}
        </button>
      </form>

      {!inviteToken && (
        <p className="mt-5 text-center text-sm text-muted">
          {isRegister ? 'Already have an account?' : 'No account yet?'}{' '}
          <button
            onClick={() => {
              setMode(isRegister ? 'login' : 'register');
              setError(null);
            }}
            className="font-medium text-brand underline underline-offset-2"
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </p>
      )}
    </main>
  );
}
