import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionSummary } from '@fabrikka/types';
import { sessions } from '../api.ts';
import { useAuth } from '../auth-context.tsx';

export function SessionListPage() {
  const { user, signOut } = useAuth();
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const refresh = useCallback(() => {
    sessions
      .list()
      .then(setList)
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(refresh, [refresh]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await sessions.create(trimmed);
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
      </main>
    </div>
  );
}
