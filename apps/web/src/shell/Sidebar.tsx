/**
 * The sidebar (M28): a team switcher, the team's recent sessions, your personal
 * sessions and your integrations — beside every page, so moving between pieces
 * of work never means going back to a list.
 *
 * It shows exactly what the session list already showed, arranged by team. No
 * new permission lives here.
 */
import { NavLink, useNavigate } from 'react-router-dom';
import type { SessionSummary } from '@fabrikka/types';
import { useAuth } from '../auth-context.tsx';
import { byActivity, useWorkspace } from './workspace.tsx';

const RECENT = 5;

function SessionLink({ s, onNavigate }: { s: SessionSummary; onNavigate: () => void }) {
  return (
    <NavLink
      to={`/o/${s.ownerSlug}/s/${s.publicId}`}
      className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')}
      onClick={onNavigate}
      title={s.title}
    >
      <span className="side-icon" aria-hidden>
        {s.role === 'viewer' ? '👥' : '#'}
      </span>
      <span className="side-label">{s.title}</span>
      {s.role === 'viewer' && <span className="side-meta">view</span>}
    </NavLink>
  );
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { user, signOut } = useAuth();
  const { sessions, teams, team, selectTeam } = useWorkspace();
  const navigate = useNavigate();

  const active = sessions.filter((s) => s.status === 'active');
  const teamSessions = team ? active.filter((s) => s.team?.id === team.id).sort(byActivity) : [];
  const personal = active.filter((s) => !s.team).sort(byActivity);

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="side-top">
        {teams.length > 0 ? (
          <select
            className="team-switcher"
            value={team?.id ?? ''}
            aria-label="Team"
            onChange={(e) => {
              selectTeam(e.target.value || null);
              navigate('/');
              onNavigate();
            }}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <strong className="side-brand">Fabrikka</strong>
        )}
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
          <span className="side-icon" aria-hidden>⌂</span>
          <span className="side-label">Home</span>
        </NavLink>
      </div>

      {team && (
        <section className="side-section" aria-label="Team sessions">
          <h2>Team sessions</h2>
          {teamSessions.length === 0 && <p className="side-empty">No sessions in {team.name} yet.</p>}
          {teamSessions.slice(0, RECENT).map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <NavLink
            to={`/teams/${team.id}/sessions`}
            className={({ isActive }) => (isActive ? 'side-item side-more on' : 'side-item side-more')}
            onClick={onNavigate}
          >
            All team sessions{teamSessions.length > RECENT ? ` (${teamSessions.length})` : ''}
          </NavLink>
        </section>
      )}

      <section className="side-section" aria-label="Personal sessions">
        <h2>Personal sessions</h2>
        {personal.length === 0 && <p className="side-empty">Sessions in no team show here.</p>}
        {personal.slice(0, 8).map((s) => (
          <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
        ))}
        {personal.length > 8 && (
          <NavLink to="/sessions?personal=1" className="side-item side-more" onClick={onNavigate}>
            All personal sessions ({personal.length})
          </NavLink>
        )}
      </section>

      <section className="side-section" aria-label="Integrations">
        <h2>Integrations</h2>
        <NavLink to="/integrations" className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
          <span className="side-icon" aria-hidden>⚇</span>
          <span className="side-label">Personal integrations</span>
        </NavLink>
      </section>

      <div className="side-bottom">
        {team && (
          <NavLink to={`/teams/${team.id}`} className="side-item" onClick={onNavigate}>
            <span className="side-icon" aria-hidden>⚙</span>
            <span className="side-label">{team.name} — people</span>
          </NavLink>
        )}
        <div className="side-user">
          <span className="muted small">@{user?.ownerSlug}</span>
          <span className="spacer" />
          <button className="link small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
