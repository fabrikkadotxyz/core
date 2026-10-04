import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionSummary, TeamSummary } from '@fabrikka/types';
import { sessions, teams } from '../api.ts';
import { useAuth } from '../auth-context.tsx';

export function SessionListPage() {
  const { user, signOut } = useAuth();
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [myTeams, setMyTeams] = useState<TeamSummary[]>([]);
  const [teamId, setTeamId] = useState('');
  const [teamName, setTeamName] = useState('');

  const refresh = useCallback(() => {
    sessions
      .list()
      .then(setList)
      .catch((err) => setError((err as Error).message));
    teams.list().then(setMyTeams).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await sessions.create(trimmed, teamId || undefined);
      setTitle('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const visible = list?.filter((s) => showArchived || s.status === 'active');

  return (
    <div className="page">
      <header className="topbar">
        <strong>Fabrikka</strong>
        <span className="spacer" />
        <span className="muted">@{user?.ownerSlug}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>

      <main className="column">
        <h1>Sessions</h1>

        <form className="inline-form" onSubmit={create}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New session — what's the problem?"
            aria-label="New session title"
          />
          {myTeams.length > 0 && (
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
              <option value="">No team</option>
              {myTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <button type="submit" disabled={!title.trim()}>
            Create
          </button>
        </form>

        {error && <p className="error">{error}</p>}

        {!list && <p className="muted">Loading…</p>}

        {visible?.length === 0 && (
          <p className="muted">
            No sessions yet. Create one above — it's private until you invite
            someone.
          </p>
        )}

        <ul className="session-list">
          {visible?.map((s) => (
            <li key={`${s.ownerSlug}/${s.publicId}`}>
              <Link to={`/o/${s.ownerSlug}/s/${s.publicId}`}>
                <span className="session-title">
                  {s.title} {s.status === 'archived' && <em>archived</em>}
                </span>
                <span className="muted small">
                  🔒 {s.memberCount} member{s.memberCount === 1 ? '' : 's'} · you are{' '}
                  {s.role}
                  {s.team && ` · ${s.team.name}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {list?.some((s) => s.status === 'archived') && (
          <button className="link" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        )}

        <h2>Teams</h2>
        {myTeams.length === 0 && (
          <p className="muted small">
            A team is the people you can add to a session without sending a link.
          </p>
        )}
        <ul className="session-list">
          {myTeams.map((t) => (
            <li key={t.id}>
              <Link to={`/teams/${t.id}`}>
                <span className="session-title">{t.name}</span>
                <span className="muted small">
                  {t.memberCount} member{t.memberCount === 1 ? '' : 's'} · you are {t.role}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!teamName.trim()) return;
            try {
              await teams.create(teamName.trim());
              setTeamName('');
              refresh();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="New team name"
            aria-label="New team name"
          />
          <button type="submit" disabled={!teamName.trim()}>
            Create team
          </button>
        </form>
      </main>
    </div>
  );
}
