/**
 * The sidebar (M28): a team switcher, the team's recent sessions, your personal
 * sessions and your integrations — beside every page, so moving between pieces
 * of work never means going back to a list.
 *
 * It shows exactly what the session list already showed, arranged by team. No
 * new permission lives here.
 */
import { Select, TeamInitial } from '../components/Select.tsx';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { SessionSummary } from '@fabrikka/types';
import { chats, sessions as sessionsApi } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { byActivity, useWorkspace } from './workspace.tsx';
import { askPermission, bannerDismissed, dismissBanner, permission } from '../notify.ts';

/**
 * M42: the first time something needs you, offer browser notifications. One
 * click here, then the browser's own Allow. Never in the desktop app, which
 * asks through the operating system.
 */
function NotifyOffer({ total }: { total: number }) {
  const [state, setState] = useState(() => (bannerDismissed() ? 'dismissed' : permission()));
  if (total === 0 || state !== 'default') return null;
  return (
    <div className="side-offer" role="status">
      <p>Get a notification when a room needs you?</p>
      <div className="side-form-row">
        <button className="small" onClick={async () => setState(await askPermission())}>
          Turn on
        </button>
        <button
          className="link small"
          onClick={() => {
            dismissBanner();
            setState('dismissed');
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * Where this build's source lives (ADR 0034, AGPL-3.0 section 13). A modified
 * Fabrikka served to others must offer its own source, and a modification means
 * a rebuild, so it's a build setting: VITE_SOURCE_URL.
 */
const SOURCE_URL = import.meta.env.VITE_SOURCE_URL || 'https://github.com/fabrikkadotxyz/core';

const RECENT = 5;

function SessionLink({ s, onNavigate }: { s: SessionSummary; onNavigate: () => void }) {
  const { needsYou } = useWorkspace();
  // M42: bold when unread; bold and a number when something in it needs you.
  const count = needsYou(s);
  const label = s.kind === 'direct' ? (s.peer ?? 'Direct chat') : s.title;
  const icon = s.kind === 'chat' ? '#' : s.kind === 'direct' ? '●' : s.role === 'viewer' ? '👥' : '▤';
  return (
    <NavLink
      to={`/o/${s.ownerSlug}/s/${s.publicId}`}
      className={({ isActive }) => `side-item${isActive ? ' on' : ''}${s.unread || count ? ' unread' : ''}${count ? ' needs' : ''}`}
      onClick={onNavigate}
      title={count ? `${label} — ${count} need${count === 1 ? 's' : ''} you` : label}
    >
      <span className="side-icon" aria-hidden>
        {icon}
      </span>
      <span className="side-label">{label}</span>
      {s.role === 'viewer' && <span className="side-meta">view</span>}
      {count > 0 && (
        <span className="side-count" aria-label={`${count} need${count === 1 ? 's' : ''} you`}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </NavLink>
  );
}

/**
 * Start a session where the sessions are (M28): in the current team, or just
 * for you. A title; Enter starts it and opens it. (Session types — templates —
 * are parked for now: the server keeps them, the UI doesn't offer them.)
 */
function NewSession({
  teamId,
  open,
  onClose,
  onCreated,
}: {
  teamId: string | null;
  open: boolean;
  onClose: () => void;
  onCreated: (s: SessionSummary) => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  return (
    <form
      className="side-form side-new-session"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setError(null);
        try {
          const s = await sessionsApi.create(title.trim(), teamId ?? undefined);
          setTitle('');
          onCreated(s);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="New session title" />
      <div className="side-form-row">
        <button type="submit" disabled={!title.trim()}>
          Start
        </button>
        <button type="button" className="link small" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && <p className="side-empty error">{error}</p>}
    </form>
  );
}

/** A section heading with a "+" that opens the section's create form. */
function SectionHead({ title, label, onAdd }: { title: string; label: string; onAdd: () => void }) {
  return (
    <div className="side-head">
      <h2>{title}</h2>
      <button className="side-add" aria-label={label} title={label} onClick={onAdd}>
        +
      </button>
    </div>
  );
}

/** Add a team chat inline: a name, Enter. Everyone on the team is in it. */
function AddChat({ teamId, onAdded }: { teamId: string; onAdded: (s: SessionSummary) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button className="side-item side-more side-button" onClick={() => setOpen(true)}>
        + Add a chat
      </button>
    );
  }
  return (
    <form
      className="side-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const s = await chats.create(teamId, name);
          setName('');
          setOpen(false);
          onAdded(s);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="chat name" aria-label="Chat name" onBlur={() => !name && setOpen(false)} />
      {error && <p className="side-empty error">{error}</p>}
    </form>
  );
}

/** Start a 1:1 chat with someone you share a team with. */
function NewDirect({ onOpened }: { onOpened: (s: SessionSummary) => void }) {
  const [people, setPeople] = useState<{ id: string; displayName: string }[] | null>(null);
  if (!people) {
    return (
      <button className="side-item side-more side-button" onClick={() => chats.people().then(setPeople).catch(() => setPeople([]))}>
        + New message
      </button>
    );
  }
  return (
    <div className="side-picker">
      {people.length === 0 && <p className="side-empty">Nobody shares a team with you yet.</p>}
      {people.map((p) => (
        <button
          key={p.id}
          className="side-item side-button"
          onClick={async () => {
            const s = await chats.direct(p.id);
            setPeople(null);
            onOpened(s);
          }}
        >
          <span className="side-icon" aria-hidden>●</span>
          <span className="side-label">{p.displayName}</span>
        </button>
      ))}
      <button className="side-item side-more side-button" onClick={() => setPeople(null)}>
        Cancel
      </button>
    </div>
  );
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { user, signOut } = useAuth();
  const { sessions, teams, team, selectTeam, needsYou } = useWorkspace();
  const navigate = useNavigate();
  // M42: another team has a room that needs you.
  const elsewhere = (teamId: string) => sessions.reduce((n, s) => n + (s.team?.id === teamId ? needsYou(s) : 0), 0);
  const otherTeamsNeedYou = teams.some((t) => t.id !== team?.id && elsewhere(t.id) > 0);

  const { refresh } = useWorkspace();
  const active = sessions.filter((s) => s.status === 'active');
  // Sessions and chats are different things (ADR 0026): each has its own section.
  const work = active.filter((s) => (s.kind ?? 'session') === 'session');
  const teamSessions = team ? work.filter((s) => s.team?.id === team.id).sort(byActivity) : [];
  const personal = work.filter((s) => !s.team).sort(byActivity);
  const teamChats = team
    ? active.filter((s) => s.kind === 'chat' && s.team?.id === team.id).sort((a, b) => a.title.localeCompare(b.title))
    : [];
  const directs = active.filter((s) => s.kind === 'direct').sort(byActivity);
  const [creating, setCreating] = useState<'team' | 'personal' | null>(null);
  const open = (s: SessionSummary) => {
    setCreating(null);
    refresh();
    navigate(`/o/${s.ownerSlug}/s/${s.publicId}`);
    onNavigate();
  };

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="side-top">
        {teams.length > 0 ? (
          <Select
            tone="sidebar"
            label="Team"
            value={team?.id ?? ''}
            options={teams.map((t) => ({
              value: t.id,
              label: t.name,
              description: `${t.memberCount} ${t.memberCount === 1 ? 'member' : 'members'}${elsewhere(t.id) ? ` · ${elsewhere(t.id)} need${elsewhere(t.id) === 1 ? 's' : ''} you` : ''}`,
              leading: <TeamInitial name={t.name} />,
            }))}
            onChange={(id) => {
              selectTeam(id || null);
              navigate('/');
              onNavigate();
            }}
          />
        ) : null}
        {teams.length > 0 && otherTeamsNeedYou ? <span className="side-team-dot" role="status" aria-label="Another team needs you" title="Another team needs you" /> : null}
        {teams.length > 0 ? null : (
          <strong className="side-brand">Fabrikka</strong>
        )}
        <NotifyOffer total={sessions.reduce((n, s) => n + needsYou(s), 0)} />
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
          <span className="side-icon" aria-hidden>⌂</span>
          <span className="side-label">Home</span>
        </NavLink>
      </div>

      {team && (
        <section className="side-section" aria-label="Team chats">
          <h2>Team chats</h2>
          {teamChats.map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <AddChat teamId={team.id} onAdded={open} />
        </section>
      )}

      {team && (
        <section className="side-section" aria-label="Team sessions">
          <SectionHead title="Team sessions" label={`New session in ${team.name}`} onAdd={() => setCreating('team')} />
          <NewSession teamId={team.id} open={creating === 'team'} onClose={() => setCreating(null)} onCreated={open} />
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

      <section className="side-section" aria-label="Direct messages">
        <h2>Direct messages</h2>
        {directs.slice(0, 8).map((s) => (
          <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
        ))}
        <NewDirect onOpened={open} />
      </section>

      <section className="side-section" aria-label="Personal sessions">
        <SectionHead title="Personal sessions" label="New personal session" onAdd={() => setCreating('personal')} />
        <NewSession teamId={null} open={creating === 'personal'} onClose={() => setCreating(null)} onCreated={open} />
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
        {team && (
          <NavLink
            to={`/teams/${team.id}/integrations`}
            className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')}
            onClick={onNavigate}
          >
            <span className="side-icon" aria-hidden>⚇</span>
            <span className="side-label">Team integrations</span>
          </NavLink>
        )}
        <NavLink to="/integrations" className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
          <span className="side-icon" aria-hidden>⚇</span>
          <span className="side-label">Personal integrations</span>
        </NavLink>
        <NavLink to="/devices" className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
          <span className="side-icon" aria-hidden>▣</span>
          <span className="side-label">Your devices</span>
        </NavLink>
      </section>

      <div className="side-bottom">
        {team && (
          <NavLink to={`/teams/${team.id}`} className="side-item" onClick={onNavigate}>
            <span className="side-icon" aria-hidden>⚙</span>
            <span className="side-label">{team.name} — people</span>
          </NavLink>
        )}
        <NavLink to="/appearance" className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
          <span className="side-icon" aria-hidden>◐</span>
          <span className="side-label">Appearance</span>
        </NavLink>
        <div className="side-user">
          <span className="muted small">@{user?.ownerSlug}</span>
          <span className="spacer" />
          <button className="link small" onClick={signOut}>
            Sign out
          </button>
        </div>
        <a className="side-source" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          Source code · AGPL-3.0
        </a>
      </div>
    </nav>
  );
}
