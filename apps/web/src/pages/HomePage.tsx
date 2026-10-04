/**
 * Home (M28): what's waiting for you, and starting something new. The lists of
 * sessions live in the sidebar, beside every page.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { TemplateSummary, WaitingItem } from '@fabrikka/types';
import { sessions, teams, templates } from '../api.ts';
import { useWorkspace } from '../shell/workspace.tsx';

export function HomePage() {
  const { team, teams: myTeams, refresh, selectTeam } = useWorkspace();
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState<WaitingItem[]>([]);
  const [tpls, setTpls] = useState<TemplateSummary[]>([]);
  const [title, setTitle] = useState('');
  const [templateRef, setTemplateRef] = useState('');
  const [where, setWhere] = useState<'team' | 'personal'>('team');
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessions.waiting().then(setWaiting).catch(() => {});
    templates.list().then(setTpls).catch(() => {});
  }, []);

  const inTeam = !!team && where === 'team';

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    try {
      const s = await sessions.create(title.trim(), inTeam ? team!.id : undefined, templateRef || undefined);
      refresh();
      navigate(`/o/${s.ownerSlug}/s/${s.publicId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

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

        <h2>Start a session</h2>
        <form className="inline-form" onSubmit={start}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What's the problem?"
            aria-label="New session title"
          />
          {tpls.length > 0 && (
            <select value={templateRef} onChange={(e) => setTemplateRef(e.target.value)} aria-label="Start from a template">
              <option value="">Blank</option>
              {tpls.map((t) => (
                <option key={t.ref} value={t.ref}>
                  {t.name}
                  {t.source === 'team' ? ` · ${t.teamName}` : t.source === 'mine' ? ' · yours' : ''}
                </option>
              ))}
            </select>
          )}
          {team && (
            <select value={where} onChange={(e) => setWhere(e.target.value as 'team' | 'personal')} aria-label="Where">
              <option value="team">In {team.name}</option>
              <option value="personal">Just for me</option>
            </select>
          )}
          <button type="submit" disabled={!title.trim()}>
            Start
          </button>
        </form>
        <p className="muted small">
          {inTeam
            ? `Private to you until you add someone — teammates on ${team!.name} can be added without a link.`
            : 'Private to you until you invite someone.'}
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
