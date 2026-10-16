/**
 * Organizations, a Settings page shown in Self only (2026-10-16, the owner's
 * call): the organizations you are in, and where a new one is created. It
 * left the home, which is for what needs you now.
 */
import { useState } from 'react';
import { TeamInitial } from '../components/Select.tsx';
import { teams } from '../api.ts';
import { useWorkspace } from '../shell/workspace.tsx';

export function Organizations() {
  const { teams: mine, refresh, selectTeam } = useWorkspace();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <p className="muted small">
        An organization is the people you can add to a session without sending a link, with its own connections and
        folders. <strong>Self</strong> is yours alone.
      </p>
      <ul className="session-list organizations">
        {mine.map((t) => (
          <li key={t.id}>
            <button className="link row" onClick={() => selectTeam(t.id)} title={`Switch to ${t.name}`}>
              <TeamInitial name={t.name} />
              <span className="session-title">{t.name}</span>
              <span className="muted small">
                {t.own ? 'yours alone' : `${t.memberCount} ${t.memberCount === 1 ? 'member' : 'members'} · you are ${t.role}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <h2>New organization</h2>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setError(null);
          try {
            const t = await teams.create(name.trim());
            setName('');
            selectTeam(t.id);
            refresh();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Organization name" aria-label="New organization name" />
        <button type="submit" disabled={!name.trim()}>
          Create organization
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  );
}
