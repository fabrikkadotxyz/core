/**
 * Every session, filterable (M28): a team's (from the sidebar's "All team
 * sessions"), your personal ones, or all of them. Archived ones on request.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { timeAgo } from '../outputs/Outputs.tsx';
import { byActivity, useWorkspace } from '../shell/workspace.tsx';

export function AllSessionsPage() {
  const { id: teamId } = useParams();
  const [params] = useSearchParams();
  const personalOnly = params.get('personal') === '1';
  const { sessions, teams } = useWorkspace();
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const team = teams.find((t) => t.id === teamId);
  const scope = sessions
    .filter((s) => (teamId ? s.team?.id === teamId : personalOnly ? !s.team : true))
    .filter((s) => showArchived || s.status === 'active')
    .filter((s) => s.title.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort(byActivity);

  return (
    <div className="page">
      <main className="column">
        <h1>{team ? `${team.name} — all sessions` : personalOnly ? 'Personal sessions' : 'All sessions'}</h1>
        <input
          className="filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title"
          aria-label="Filter sessions by title"
        />
        {scope.length === 0 && <p className="muted">Nothing matches.</p>}
        <ul className="session-list">
          {scope.map((s) => (
            <li key={`${s.ownerSlug}/${s.publicId}`}>
              <Link to={`/o/${s.ownerSlug}/s/${s.publicId}`}>
                <span className="session-title">
                  {s.title} {s.status === 'archived' && <em>archived</em>}
                </span>
                <span className="muted small">
                  {s.role === 'viewer' ? '👥' : '🔒'} {s.memberCount} member{s.memberCount === 1 ? '' : 's'} · you are{' '}
                  {s.role} · active {timeAgo(s.lastActivityAt ?? s.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <button className="link" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </main>
    </div>
  );
}
