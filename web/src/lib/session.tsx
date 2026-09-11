import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setActiveOrg } from './api';
import type { Permission, Session } from './types';

/**
 * Session context.
 *
 * The session is fetched with React Query rather than held in a bespoke
 * provider, so every surface that needs it shares one cache entry and one
 * request, and invalidating it after a workspace switch refreshes the whole app
 * without prop-drilling or a page reload.
 */

interface SessionValue {
  session: Session | null;
  isLoading: boolean;
  /** True once the session request has settled, however it settled. */
  isReady: boolean;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const { data, isLoading, isFetched } = useQuery({
    queryKey: ['session'],
    queryFn: api.session,
    // A 401 is the expected answer for a signed-out visitor, not a failure to
    // retry - retrying it just delays the sign-in screen.
    retry: (count, error) => !(error instanceof ApiError && error.isAuth) && count < 2,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // Mirror the active workspace into the API client so every subsequent
  // request carries the org header, including from a second tab set to a
  // different workspace.
  useEffect(() => {
    setActiveOrg(data?.org?.id ?? null);
  }, [data?.org?.id]);

  const value: SessionValue = {
    session: data ?? null,
    isLoading,
    isReady: isFetched,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['session'] });
    },
    // Permissions come from the server, which is also what enforces them. The
    // UI hides what you cannot do; the API still refuses it if you try anyway.
    can: (permission: Permission) => data?.permissions?.includes(permission) ?? false,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}

/** Convenience for the common `can('list:write')` check. */
export function usePermission(permission: Permission): boolean {
  return useSession().can(permission);
}
