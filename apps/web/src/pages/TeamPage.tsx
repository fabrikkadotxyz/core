/**
 * A team: who's on it, and how to bring someone in (M21, ADR 0025).
 *
 * Deliberately small. A team is a list of people; owners invite and remove, and
 * anyone can leave. It never lists anyone's sessions — being on a team reveals
 * nothing about what teammates are working on.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { TeamDetail } from '@fabrikka/types';
import { teams, ApiError } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { useWorkspace } from '../shell/workspace.tsx';

export function TeamPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { refresh } = useWorkspace();
  const [team, setTeam] = useState<TeamDetail | null | 'missing' | 'failed'>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    teams
      .get(id)
      .then(setTeam)
      .catch((err) => setTeam(err instanceof ApiError && err.status === 404 ? 'missing' : 'failed'));
  }, [id]);
  useEffect(load, [load]);

  if (team === null) return <main className="centered">Loading…</main>;
  // Only a 404 means the team isn't yours; anything else (offline, a server error) says so.
  if (team === 'failed') {
    return (
      <main className="centered">
        <div className="card">
          <h1>Couldn't load this organization</h1>
          <p className="muted">Check your connection and try again.</p>
          <button onClick={load}>Try again</button>
          <Link to="/">← Sessions</Link>
        </div>
      </main>
    );
  }
  if (team === 'missing') {
    return (
      <main className="centered">
        <div className="card">
          <h1>No such organization</h1>
          <p className="muted">It doesn't exist, or you're not on it.</p>
          <Link to="/">← Sessions</Link>
        </div>
      </main>
    );
  }

  const isOwner = team.role === 'owner';

  const invite = async () => {
    setError(null);
    try {
      const created = await teams.createInvite(team.id);
      setInviteUrl(created.url);
      setCopied(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (userId: string, leaving: boolean) => {
    setError(null);
    try {
      await teams.removeMember(team.id, userId);
      refresh();
      if (leaving) navigate('/', { replace: true });
      else load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <main className="column">
        <h1>{team.name}</h1>
        <p className="muted">
          An organization is the people a session owner can add without a link. Sessions in an organization are
          still private until their owner adds someone.
        </p>

        <h2>Members</h2>
        <ul className="session-list">
          {team.members.map((m) => (
            <li key={m.userId} className="team-member">
              <span>
                <strong>{m.displayName}</strong> <span className="muted small">{m.email}</span>
              </span>
              <span className="spacer" />
              <span className="muted small">{m.role}</span>
              {isOwner && m.userId !== user?.id && (
                <button className="link small" onClick={() => remove(m.userId, false)}>
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>

        {isOwner && (
          <section className="team-invite">
            <button onClick={invite}>Create invite link</button>
            {inviteUrl && (
              <div className="fresh-invite">
                <p className="hint">
                  <strong>Copy this now — it is shown only once.</strong> Whoever opens it can join
                  the organization, creating an account if they need one, until it's used or expires.
                </p>
                <code className="endpoint">{inviteUrl}</code>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inviteUrl);
                      setCopied(true);
                    } catch {
                      setError('could not copy — select the link and copy it manually');
                    }
                  }}
                >
                  {copied ? 'Copied ✓' : 'Copy invite link'}
                </button>
              </div>
            )}
          </section>
        )}

        {error && <p className="error">{error}</p>}

        <p>
          <button className="link danger" onClick={() => user && remove(user.id, true)}>
            Leave organization
          </button>
        </p>
      </main>
    </div>
  );
}
