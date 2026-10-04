/**
 * Home (M28): what's waiting for you, and your teams. Sessions — listing them
 * and starting them — live in the sidebar, beside every page.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { WaitingItem } from '@fabrikka/types';
import { sessions, teams } from '../api.ts';
import { useWorkspace } from '../shell/workspace.tsx';

export function HomePage() {
  const { team, teams: myTeams, refresh, selectTeam } = useWorkspace();
  const [waiting, setWaiting] = useState<WaitingItem[]>([]);
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessions.waiting().then(setWaiting).catch(() => {});
  }, []);

  return (
    <div className="page">
      <main className="column">
        <h1>{team ? team.name : 'Fabrikka'}</h1>

        {waiting.length > 0 && (
          <section className="waiting" aria-label="Waiting for you">
            <h2>Waiting for you</h2>
            <ul className="session-list">
              {waiting.map((w, i) => (
                <li key={i}>
                  <Link to={`/o/${w.session.ownerSlug}/s/${w.session.publicId}`}>
                    <span className="session-title">
                      @{w.from} <span className="muted small">in {w.session.title}</span>
                    </span>
                    <span className="small">{w.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="muted small">
          Start a session with the <strong>+</strong> beside <em>Team sessions</em> or{' '}
          <em>Personal sessions</em> in the sidebar.
        </p>
        {error && <p className="error">{error}</p>}

        <h2>Teams</h2>
        {myTeams.length === 0 && (
          <p className="muted small">A team is the people you can add to a session without sending a link.</p>
        )}
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!teamName.trim()) return;
            try {
              const t = await teams.create(teamName.trim());
              setTeamName('');
              selectTeam(t.id);
              refresh();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name" aria-label="New team name" />
          <button type="submit" disabled={!teamName.trim()}>
            Create team
          </button>
        </form>
      </main>
    </div>
  );
}
