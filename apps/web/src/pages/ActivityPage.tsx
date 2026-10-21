/**
 * Activity (M60, ADR 0058), a Settings tab for an organization's owners: who
 * did what in it and in its rooms. Sign-ins and their failures, membership,
 * invites, grants, connections, exports, deletions. Never what anyone said.
 * A filter by kind, a CSV download, and how long it is kept.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuditEventView } from '@fabrikka/types';
import { teams, type RetentionView } from '../api.ts';

/** M63: what the organization's rooms keep, and for how long. Owners only. */
function Retention({ teamId }: { teamId: string }) {
  const [state, setState] = useState<RetentionView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    teams.retention(teamId).then(setState).catch(() => setState(null));
  }, [teamId]);
  if (!state) return null;
  const rows: { key: 'messageDays' | 'outputDays' | 'fileDays'; label: string; by: string }[] = [
    { key: 'messageDays', label: 'Messages', by: 'from when they were written' },
    { key: 'outputDays', label: 'Documents', by: 'from their last edit' },
    { key: 'fileDays', label: 'Uploaded files', by: 'from when they were added' },
  ];
  return (
    <section aria-label="What the rooms keep">
      <h2>What the rooms keep</h2>
      <p className="muted small">
        By default everything stays. Choosing a window deletes what is older, daily, in every room of this organization; choosing a shorter one deletes it now.
        Notes, links and the trail are not affected.
      </p>
      {rows.map((r) => (
        <p key={r.key} className="small">
          <label>
            {r.label}: keep{' '}
            <select
              value={state[r.key] ?? ''}
              onChange={async (e) => {
                setError(null);
                setNote(null);
                const value = e.target.value === '' ? null : Number(e.target.value);
                try {
                  const res = await teams.setRetention(teamId, { [r.key]: value });
                  setState(res);
                  const gone = res.pruned.messages + res.pruned.outputs + res.pruned.files;
                  setNote(gone ? `Deleted ${res.pruned.messages} message(s), ${res.pruned.outputs} document(s), ${res.pruned.files} file(s) past the window.` : 'Nothing was older than that.');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <option value="">forever</option>
              {state.choices.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>{' '}
          <span className="muted">{r.by}</span>
        </p>
      ))}
      {note && <p className="hint">{note}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const KINDS: { key: string; label: string }[] = [
  { key: '', label: 'Everything' },
  { key: 'login', label: 'Sign-ins' },
  { key: 'account', label: 'Accounts' },
  { key: 'team', label: 'Organization' },
  { key: 'invite', label: 'Invites' },
  { key: 'member', label: 'Members' },
  { key: 'session', label: 'Rooms' },
  { key: 'agent', label: 'Agents' },
  { key: 'token', label: 'Tokens' },
  { key: 'connection', label: 'Connections' },
  { key: 'grant', label: 'Grants' },
  { key: 'deployment', label: 'Hosting' },
];

/** One line a person can read: who did what, to whom, where. */
export function describe(e: AuditEventView): string {
  const who = e.actor.userId ? (e.actor.name ?? 'someone') : e.actor.kind === 'operator' ? 'the operator' : e.actor.kind === 'system' ? 'Fabrikka' : 'the hosting';
  const whom = e.subject ? (e.subject.name ?? 'someone') : '';
  const d = e.detail;
  const room = e.session?.title ? ` in “${e.session.title}”` : d.title ? ` “${String(d.title)}”` : '';
  switch (e.action) {
    case 'login.ok': return `${who} signed in`;
    case 'login.failed': return `a sign-in as ${whom || 'an unknown address'} failed`;
    case 'login.locked': return `sign-ins as ${whom || 'an unknown address'} were refused: too many failures`;
    case 'logout': return `${who} signed out`;
    case 'profile.picture_changed': return `${who} chose a new profile picture`;
    case 'profile.picture_removed': return `${who} removed their profile picture`;
    case 'password.reset_requested': return `a password reset was asked for ${whom || 'an unknown address'}`;
    case 'password.reset_completed': return e.outcome === 'ok' ? 'a password was reset by link' : 'a password reset link was refused';
    case 'account.deactivated': return `${who} deactivated ${whom}`;
    case 'account.reactivated': return `${who} reactivated ${whom}`;
    case 'account.deletion_requested': return e.outcome === 'refused' ? `${whom} tried to delete their account with the wrong password` : `${whom} asked for their account to be deleted`;
    case 'account.deletion_cancelled': return `${whom} signed in and kept their account`;
    case 'account.deleted': return `${whom}'s account was deleted by ${who}`;
    case 'team.created': return `${who} created the organization`;
    case 'team.member_removed': return d.left ? `${whom} left the organization` : `${who} removed ${whom} from the organization`;
    case 'team.audit_days_changed': return `${who} set the trail to ${String(d.days)} days`;
    case 'invite.created': return `${who} created a ${String(d.role ?? 'member')} invite${room}`;
    case 'invite.revoked': return `${who} revoked an invite${room}`;
    case 'invite.redeemed': return `${whom} joined through an invite${d.team ? ` (${String(d.team)})` : ''}`;
    case 'session.deleted': return `${who} deleted the room${room}`;
    case 'session.exported': return `${who} exported${room}`;
    case 'member.added': return `${who} added ${whom}${room}`;
    case 'member.removed': return `${who} removed ${whom}${room}`;
    case 'guest.removed': return `${who} removed guest ${whom}${room}`;
    case 'agent.added': return `${who} added agent @${String(d.agent)}${room}`;
    case 'agent.trust_changed': return `${who} set @${String(d.agent)} to ${String(d.trustTier)}${room}`;
    case 'agents.paused': return `${who} paused the agents${room}`;
    case 'agents.resumed': return `${who} resumed the agents${room}`;
    case 'token.issued': return `${who} issued an agent token${room}`;
    case 'token.revoked': return `${who} revoked an agent token${room}`;
    case 'connection.attached': return `${who} ${e.session ? 'attached' : 'added'} ${d.shared ? 'the shared' : 'a'} ${String(d.slug)} connection${room}`;
    case 'connection.removed': return `${who} removed ${d.shared ? 'the shared' : 'a'} ${String(d.slug)} connection${room}`;
    case 'grant.changed':
      return d.tool
        ? `${who} ${d.allowed ? 'allowed' : 'denied'} ${String(d.slug)}__${String(d.tool)}${room}`
        : `${who} set ${String(d.slug)} grants to ${String(d.preset)}${room}`;
    default:
      return e.action.startsWith('admin.') ? `the operator ran ${e.action.slice(6).replace('_', '-')}${whom ? ` for ${whom}` : ''}` : `${who}: ${e.action}${whom ? ` → ${whom}` : ''}${room}`;
  }
}

export function OrganizationActivity({ teamId }: { teamId: string }) {
  const [kind, setKind] = useState('');
  const [state, setState] = useState<{ events: AuditEventView[]; auditDays: number; choices: readonly number[] } | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    teams
      .audit(teamId, kind || undefined)
      .then((r) => {
        setState(r);
        setDenied(false);
      })
      .catch(() => setDenied(true));
  }, [teamId, kind]);
  useEffect(load, [load]);

  if (denied) return <p className="muted small">Only organization owners see its activity.</p>;
  if (!state) return <p className="muted small">Loading…</p>;

  return (
    <>
      <section aria-label="Activity">
        <p className="muted small">
          Who did what in this organization and its rooms: sign-ins and their failures, membership, invites, grants, connections,
          exports, deletions. Never what anyone wrote.
        </p>
        <p>
          <label>
            Show{' '}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>{' '}
          <a className="small" href={`/api/teams/${teamId}/audit?format=csv${kind ? `&action=${kind}` : ''}`}>
            Download CSV
          </a>
        </p>
        {state.events.length === 0 && <p className="muted small">Nothing yet.</p>}
        <ul className="team-members">
          {state.events.map((e) => (
            <li key={e.id} className="team-member small">
              <span>
                {describe(e)}
                {e.outcome !== 'ok' && <span className="error"> · {e.outcome}</span>}
              </span>
              <span className="spacer" />
              <span className="muted" title={e.ip ?? undefined}>
                {new Date(e.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="How long it is kept">
        <h2>How long it is kept</h2>
        <p className="muted small">
          <label>
            Keep activity for{' '}
            <select
              value={state.auditDays}
              onChange={async (e) => {
                setError(null);
                try {
                  const r = await teams.setAuditDays(teamId, Number(e.target.value));
                  setState((s) => (s ? { ...s, auditDays: r.auditDays } : s));
                  load();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              {state.choices.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          . Older events are deleted daily; choosing fewer days deletes them now.
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <Retention teamId={teamId} />
    </>
  );
}
