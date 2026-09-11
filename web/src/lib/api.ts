const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? '').replace(/\/$/, '');
import type {
  Analytics,
  CandidateDetail,
  CompareResponse,
  Facets,
  Filters,
  IngestJob,
  IngestStatus,
  ListDetail,
  ListSummary,
  MembersResponse,
  Plan,
  RoleName,
  SavedSearch,
  SearchResponse,
  Session,
  Stage,
} from './types';

/**
 * Typed API client.
 *
 * One fetch wrapper, one error type. Two decisions worth noting:
 *
 *  - `credentials: 'include'` on every call, because the session is an
 *    httpOnly cookie. It cannot be read by script, so there is no token to
 *    attach by hand and no token sitting in localStorage for an XSS to steal.
 *  - Errors become ApiError carrying the HTTP status, so callers can branch on
 *    402 (plan limit) and 403 (permission) without string-matching messages.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Plan limit reached - the UI offers an upgrade rather than an error. */
  get isPlanLimit() {
    return this.status === 402;
  }
  get isPermission() {
    return this.status === 403;
  }
  get isAuth() {
    return this.status === 401;
  }
}

/** The active workspace, mirrored from the cookie the server sets. */
let activeOrgId: string | null = null;
export function setActiveOrg(orgId: string | null) {
  activeOrgId = orgId;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  // Sent explicitly as well as via cookie so two browser tabs can be in two
  // different workspaces at once.
  if (activeOrgId) headers.set('x-devscout-org', activeOrgId);

  const res = await fetch(`${apiOrigin}/api${path}`, { ...init, headers, credentials: 'include' });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error ?? `Request failed (${res.status})`,
      body?.code,
      body?.details,
    );
  }
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body);

/** Serialises filters into the query string the search endpoint expects. */
export function filtersToParams(filters: Partial<Filters>): URLSearchParams {
  const p = new URLSearchParams();
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      if (value.length) p.set(key, value.join(','));
      return;
    }
    p.set(key, String(value));
  };

  put('q', filters.q);
  put('languages', filters.languages);
  put('topics', filters.topics);
  put('locations', filters.locations);
  put('seniority', filters.seniority);
  put('minFollowers', filters.minFollowers);
  put('minStars', filters.minStars);
  put('minRepos', filters.minRepos);
  put('activeWithinDays', filters.activeWithinDays);
  put('hireable', filters.hireable);
  put('savedOnly', filters.savedOnly);
  put('excludeSaved', filters.excludeSaved);
  // 'hybrid' and 'relevance' are the defaults; leaving them out keeps a shared
  // URL short and readable.
  if (filters.mode && filters.mode !== 'hybrid') put('mode', filters.mode);
  if (filters.sort && filters.sort !== 'relevance') put('sort', filters.sort);

  return p;
}

export const api = {
  /* ---- auth & session ---- */
  session: () => request<Session>('/auth/session'),
  login: (email: string, password: string) =>
    request<{ ok: true }>('/auth/login', { method: 'POST', body: json({ email, password }) }),
  register: (input: {
    email: string;
    password: string;
    name?: string;
    orgName?: string;
    inviteToken?: string;
  }) => request<{ ok: true }>('/auth/register', { method: 'POST', body: json(input) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  switchOrg: (orgId: string) =>
    request<{ orgId: string }>('/auth/switch-org', { method: 'POST', body: json({ orgId }) }),
  createOrg: (name: string) =>
    request<{ id: string; name: string; slug: string }>('/auth/orgs', {
      method: 'POST',
      body: json({ name }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/auth/change-password', {
      method: 'POST',
      body: json({ currentPassword, newPassword }),
    }),
  plans: () => request<Plan[]>('/auth/plans'),

  /* ---- search ---- */
  search: (filters: Partial<Filters>, offset: number, limit = 25) => {
    const p = filtersToParams(filters);
    p.set('offset', String(offset));
    p.set('limit', String(limit));
    return request<SearchResponse>(`/search?${p}`);
  },
  facets: (filters: Partial<Filters>) =>
    request<Facets>(`/search/facets?${filtersToParams(filters)}`),
  suggest: (q: string) =>
    request<{
      suggestions: Array<{ kind: string; value: string; label: string; meta: string | null }>;
    }>(`/search/suggest?q=${encodeURIComponent(q)}`),

  /* ---- candidates ---- */
  candidate: (login: string) => request<CandidateDetail>(`/candidates/${encodeURIComponent(login)}`),
  compare: (logins: string[]) =>
    request<CompareResponse>(`/candidates?logins=${logins.map(encodeURIComponent).join(',')}`),
  refreshCandidate: (login: string) =>
    request<{ jobId: string }>(`/candidates/${encodeURIComponent(login)}/refresh`, {
      method: 'POST',
    }),

  /* ---- pipelines ---- */
  lists: () => request<ListSummary[]>('/lists'),
  list: (id: string) => request<ListDetail>(`/lists/${id}`),
  createList: (input: { name: string; description?: string; color?: string }) =>
    request<ListSummary>('/lists', { method: 'POST', body: json(input) }),
  updateList: (id: string, input: { name?: string; description?: string | null; color?: string }) =>
    request<ListSummary>(`/lists/${id}`, { method: 'PATCH', body: json(input) }),
  deleteList: (id: string) => request<void>(`/lists/${id}`, { method: 'DELETE' }),

  addToList: (
    listId: string,
    input: { developerId: string; stage?: Stage; sourceQuery?: string; evidence?: unknown },
  ) => request<{ id: string }>(`/lists/${listId}/members`, { method: 'POST', body: json(input) }),
  updateMember: (
    listId: string,
    memberId: string,
    input: { stage?: Stage; rating?: number | null; position?: number },
  ) =>
    request<{ id: string }>(`/lists/${listId}/members/${memberId}`, {
      method: 'PATCH',
      body: json(input),
    }),
  removeFromList: (listId: string, memberId: string) =>
    request<void>(`/lists/${listId}/members/${memberId}`, { method: 'DELETE' }),

  /* ---- notes & tags ---- */
  addNote: (developerId: string, body: string) =>
    request<CandidateDetail['notes'][number]>(`/lists/notes/${developerId}`, {
      method: 'POST',
      body: json({ body }),
    }),
  updateNote: (noteId: string, body: string) =>
    request<CandidateDetail['notes'][number]>(`/lists/notes/${noteId}`, {
      method: 'PATCH',
      body: json({ body }),
    }),
  deleteNote: (noteId: string) => request<void>(`/lists/notes/${noteId}`, { method: 'DELETE' }),
  addTag: (developerId: string, label: string) =>
    request<{ id: string; label: string }>(`/lists/tags/${developerId}`, {
      method: 'POST',
      body: json({ label }),
    }),
  deleteTag: (tagId: string) => request<void>(`/lists/tags/${tagId}`, { method: 'DELETE' }),
  allTags: () => request<Array<{ label: string; count: number }>>('/lists/tags/all'),

  /* ---- saved searches ---- */
  savedSearches: () => request<SavedSearch[]>('/saved-searches'),
  createSavedSearch: (input: {
    name: string;
    query: string;
    filters: Partial<Filters>;
    isShared?: boolean;
  }) => request<SavedSearch>('/saved-searches', { method: 'POST', body: json(input) }),
  updateSavedSearch: (id: string, input: Partial<{ name: string; query: string; filters: Partial<Filters> }>) =>
    request<SavedSearch>(`/saved-searches/${id}`, { method: 'PATCH', body: json(input) }),
  /** Bumps the run counter. `created_by_name` needs a join the update does not
   *  do, so it is absent from this response rather than declared and undefined. */
  runSavedSearch: (id: string) =>
    request<Omit<SavedSearch, 'created_by_name'>>(`/saved-searches/${id}/run`, {
      method: 'POST',
    }),
  deleteSavedSearch: (id: string) => request<void>(`/saved-searches/${id}`, { method: 'DELETE' }),

  /* ---- team ---- */
  members: () => request<MembersResponse>('/orgs/members'),
  invite: (email: string, role: RoleName) =>
    request<{ invite: { id: string; email: string }; acceptUrl: string }>('/orgs/invites', {
      method: 'POST',
      body: json({ email, role }),
    }),
  revokeInvite: (id: string) => request<void>(`/orgs/invites/${id}`, { method: 'DELETE' }),
  acceptInvite: (token: string) =>
    request<{ orgId: string }>('/orgs/invites/accept', { method: 'POST', body: json({ token }) }),
  updateMemberRole: (id: string, role: RoleName) =>
    request<{ id: string; role: RoleName }>(`/orgs/members/${id}`, {
      method: 'PATCH',
      body: json({ role }),
    }),
  removeMember: (id: string) => request<void>(`/orgs/members/${id}`, { method: 'DELETE' }),
  updateOrg: (name: string) => request<{ name: string }>('/orgs', { method: 'PATCH', body: json({ name }) }),
  auditLog: () =>
    request<
      Array<{
        id: string;
        actor_email: string | null;
        action: string;
        target_type: string | null;
        meta: Record<string, unknown>;
        created_at: string;
      }>
    >('/orgs/audit'),

  /* ---- analytics & ops ---- */
  analytics: (days = 30) => request<Analytics>(`/analytics?days=${days}`),
  ingestStatus: () => request<IngestStatus>('/ingest/status'),
  ingestJobs: (status?: string) =>
    request<{ jobs: IngestJob[]; stats: Analytics['queue'] }>(
      `/ingest/jobs${status ? `?status=${status}` : ''}`,
    ),
  ingestProfile: (login: string) =>
    request<{ job: IngestJob; deduped: boolean }>('/ingest/profile', {
      method: 'POST',
      body: json({ login }),
    }),
  discover: (query: string, perPage = 30) =>
    request<{ job: IngestJob; deduped: boolean }>('/ingest/discover', {
      method: 'POST',
      body: json({ query, perPage }),
    }),
  retryJob: (id: string) => request<IngestJob>(`/ingest/jobs/${id}/retry`, { method: 'POST' }),

  /* ---- billing ---- */
  billing: () =>
    request<{
      plan: string;
      subscription_status: string;
      current_period_end: string | null;
      cancel_at_period_end: boolean;
      seats: number;
      has_billing_account: boolean;
      enabled: boolean;
    }>('/billing'),
  checkout: (plan: 'team' | 'scale') =>
    request<{ url: string }>('/billing/checkout', { method: 'POST', body: json({ plan }) }),
  portal: () => request<{ url: string }>('/billing/portal', { method: 'POST' }),

  /* ---- export ----
   * Returns a Blob rather than navigating, so a 402 or 403 surfaces as an
   * in-app message instead of a browser tab showing raw JSON. */
  exportCsv: async (listId?: string): Promise<Blob> => {
    const res = await fetch(`${apiOrigin}/api/export/csv${listId ? `?listId=${listId}` : ''}`, {
      credentials: 'include',
      headers: activeOrgId ? { 'x-devscout-org': activeOrgId } : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, body?.error ?? 'Export failed', body?.code);
    }
    return res.blob();
  },
};
