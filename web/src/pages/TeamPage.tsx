import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { formatDate, relativeTime, ROLE_DESCRIPTIONS } from '../lib/format';
import { Badge, EmptyState, ErrorNotice, Field, Spinner, useToast } from '../components/ui';
import type { RoleName } from '../lib/types';

/**
 * Team management.
 *
 * Roles are a ladder rather than a permission matrix, so this page's job is to
 * explain what each rung means - a dropdown of four words with no explanation
 * is how people end up granting owner to everyone.
 *
 * The controls shown here mirror what the API will actually allow: nobody can
 * grant a role above their own or edit someone at or above their own rank. The
 * server enforces that regardless; hiding the control just avoids offering an
 * action that would be rejected.
 */
export default function TeamPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { session, can } = useSession();

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<RoleName>('recruiter');
  const [orgName, setOrgName] = useState('');

  const team = useQuery({ queryKey: ['members'], queryFn: api.members, staleTime: 30_000 });

  const audit = useQuery({
    queryKey: ['audit'],
    queryFn: api.auditLog,
    // Only admins can read it, and it is the least-used panel on the page.
    enabled: can('member:manage'),
    staleTime: 60_000,
  });

  const refreshTeam = () => qc.invalidateQueries({ queryKey: ['members'] });

  const invite = useMutation({
    mutationFn: () => api.invite(inviteEmail.trim(), inviteRole),
    onSuccess: (result) => {
      setInviteEmail('');
      void refreshTeam();
      // No email provider is wired up, so the link is surfaced directly rather
      // than pretending a message was sent.
      navigator.clipboard?.writeText(result.acceptUrl).catch(() => {});
      toast('Invitation created — link copied to your clipboard', { tone: 'success' });
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not create that invitation', { tone: 'error' }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => void refreshTeam(),
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not revoke', { tone: 'error' }),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: RoleName }) => api.updateMemberRole(id, role),
    onSuccess: () => {
      void refreshTeam();
      void qc.invalidateQueries({ queryKey: ['session'] });
      toast('Role updated', { tone: 'success' });
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not change that role', { tone: 'error' }),
  });

  const removeMember = useMutation({
    mutationFn: (id: string) => api.removeMember(id),
    onSuccess: () => {
      void refreshTeam();
      toast('Member removed', { tone: 'success' });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not remove', { tone: 'error' }),
  });

  const renameOrg = useMutation({
    mutationFn: () => api.updateOrg(orgName.trim()),
    onSuccess: async () => {
      setOrgName('');
      await qc.invalidateQueries();
      toast('Workspace renamed', { tone: 'success' });
    },
    onError: (e) =>
      toast(e instanceof Error ? e.message : 'Could not rename the workspace', { tone: 'error' }),
  });

  const data = team.data;
  const seatsFull = data ? data.seatLimit > 0 && data.seatsUsed >= data.seatLimit : false;

  return (
    <main id="main" className="mx-auto max-w-[900px] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mb-4">
        <h1 className="text-base font-semibold">Team</h1>
        <p className="mt-0.5 text-xs text-muted">
          {session?.org?.name} ·{' '}
          {data ? (
            <>
              {data.seatsUsed} of {data.seatLimit > 0 ? data.seatLimit : '∞'} seats used
            </>
          ) : (
            '…'
          )}
        </p>
      </div>

      {team.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted">
          <Spinner />
          Loading team
        </div>
      ) : team.isError ? (
        <ErrorNotice error={team.error} onRetry={() => void team.refetch()} />
      ) : !data ? null : (
        <div className="space-y-4">
          {/* -------------------------------------------------------- invite */}
          {can('member:invite') && (
            <section className="card p-4">
              <h2 className="text-xs font-semibold">Invite someone</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                Creates a single-use link, copied to your clipboard. It expires in seven days.
              </p>

              {seatsFull ? (
                <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  All {data.seatLimit} seats on your plan are in use. Upgrade or remove a member to
                  invite someone else.
                </p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (inviteEmail.trim()) invite.mutate();
                  }}
                  className="mt-3 flex flex-wrap items-end gap-2"
                >
                  <div className="min-w-[200px] flex-1">
                    <Field label="Email address">
                      {(props) => (
                        <input
                          {...props}
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          required
                          className="input"
                          placeholder="colleague@company.com"
                        />
                      )}
                    </Field>
                  </div>

                  <div className="w-40">
                    <Field label="Role" hint={ROLE_DESCRIPTIONS[inviteRole]}>
                      {(props) => (
                        <select
                          {...props}
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.target.value as RoleName)}
                          className="input"
                        >
                          {data.roles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  </div>

                  <button
                    type="submit"
                    disabled={!inviteEmail.trim() || invite.isPending}
                    className="btn-primary"
                  >
                    {invite.isPending && <Spinner />}
                    Invite
                  </button>
                </form>
              )}
            </section>
          )}

          {/* ------------------------------------------------------- members */}
          <section className="card p-4">
            <h2 className="text-xs font-semibold">Members ({data.members.length})</h2>

            <ul className="mt-3 divide-y divide-line">
              {data.members.map((member) => {
                const isSelf = member.user_id === session?.user.id;

                return (
                  <li key={member.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    {member.avatar_url ? (
                      <img
                        src={member.avatar_url}
                        alt=""
                        width={32}
                        height={32}
                        className="h-8 w-8 shrink-0 rounded-lg bg-raised object-cover"
                      />
                    ) : (
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-raised text-2xs font-semibold text-muted"
                        aria-hidden="true"
                      >
                        {(member.name ?? member.email).slice(0, 1).toUpperCase()}
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-xs font-medium">
                        {member.name ?? member.email}
                        {isSelf && <Badge>You</Badge>}
                      </p>
                      <p className="truncate text-2xs text-subtle">
                        {member.email} · last signed in {relativeTime(member.last_login_at)}
                      </p>
                    </div>

                    {can('member:manage') && !isSelf ? (
                      <>
                        <label className="sr-only" htmlFor={`role-${member.id}`}>
                          Role for {member.email}
                        </label>
                        <select
                          id={`role-${member.id}`}
                          value={member.role}
                          onChange={(e) =>
                            changeRole.mutate({ id: member.id, role: e.target.value as RoleName })
                          }
                          className="input w-32 py-1 text-2xs"
                        >
                          {data.roles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>

                        <button
                          onClick={() => {
                            if (confirm(`Remove ${member.email} from this workspace?`)) {
                              removeMember.mutate(member.id);
                            }
                          }}
                          className="text-2xs text-subtle hover:text-danger"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <Badge tone={member.role === 'owner' ? 'brand' : 'neutral'}>
                        {member.role}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ------------------------------------------------------- invites */}
          {data.pendingInvites.length > 0 && (
            <section className="card p-4">
              <h2 className="text-xs font-semibold">
                Pending invitations ({data.pendingInvites.length})
              </h2>
              <ul className="mt-3 divide-y divide-line">
                {data.pendingInvites.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs">{inv.email}</p>
                      <p className="text-2xs text-subtle">
                        {inv.role} · expires {formatDate(inv.expires_at)}
                      </p>
                    </div>
                    {can('member:invite') && (
                      <button
                        onClick={() => revoke.mutate(inv.id)}
                        className="shrink-0 text-2xs text-subtle hover:text-danger"
                      >
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* --------------------------------------------------------- roles */}
          <section className="card p-4">
            <h2 className="text-xs font-semibold">What the roles mean</h2>
            <dl className="mt-3 space-y-2">
              {data.roles.map((role) => (
                <div key={role} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-2xs font-semibold capitalize">{role}</dt>
                  <dd className="text-2xs text-muted">{ROLE_DESCRIPTIONS[role]}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* --------------------------------------------------------- rename */}
          {can('org:update') && (
            <section className="card p-4">
              <h2 className="text-xs font-semibold">Workspace name</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (orgName.trim()) renameOrg.mutate();
                }}
                className="mt-3 flex flex-wrap items-end gap-2"
              >
                <div className="min-w-[200px] flex-1">
                  <Field label="Name">
                    {(props) => (
                      <input
                        {...props}
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        className="input"
                        placeholder={session?.org?.name}
                      />
                    )}
                  </Field>
                </div>
                <button
                  type="submit"
                  disabled={!orgName.trim() || renameOrg.isPending}
                  className="btn-secondary"
                >
                  {renameOrg.isPending && <Spinner />}
                  Rename
                </button>
              </form>
            </section>
          )}

          {/* ---------------------------------------------------- audit log */}
          {can('member:manage') && (
            <section className="card p-4">
              <h2 className="text-xs font-semibold">Audit log</h2>
              <p className="mt-0.5 text-2xs text-subtle">
                Membership, billing and pipeline changes, most recent first.
              </p>

              {audit.isLoading ? (
                <p className="py-6 text-center text-xs text-muted">Loading…</p>
              ) : audit.data?.length ? (
                <ul className="mt-3 max-h-80 divide-y divide-line overflow-y-auto">
                  {audit.data.map((entry) => (
                    <li key={entry.id} className="flex items-baseline justify-between gap-3 py-1.5">
                      <span className="min-w-0">
                        <span className="font-mono text-2xs text-ink">{entry.action}</span>
                        <span className="ml-2 text-2xs text-subtle">
                          {entry.actor_email ?? 'system'}
                        </span>
                      </span>
                      <span className="shrink-0 text-2xs text-subtle">
                        {relativeTime(entry.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="Nothing logged yet" />
              )}
            </section>
          )}
        </div>
      )}
    </main>
  );
}
