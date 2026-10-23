/**
 * The list beside the icon rail (M28, reshaped in M51 by ADR 0048): the
 * organization switcher at the top, then what belongs to the place you are in.
 * Sessions: Home, the organization's sessions, your personal ones. Chats: the
 * organization's chats and your direct messages. Integrations and Settings:
 * their pages, one row each. Beside every page, so moving between pieces of
 * work never means going back to a list.
 *
 * It shows exactly what the session list already showed, arranged by place. No
 * new permission lives here.
 */
import { Select, TeamInitial } from '../components/Select.tsx';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { SessionSummary } from '@fabrikka/types';
import { chats, sessions as sessionsApi } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { Face } from '../components/Face.tsx';
import { byActivity, useWorkspace } from './workspace.tsx';
import { PLACE_LABEL, type Place } from './Rail.tsx';
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
 * Start a session where the sessions are (M28): in the current organization,
 * for it to read along or for you alone (M53). A title; Enter starts it and opens it. (Session types — templates —
 * are parked for now: the server keeps them, the UI doesn't offer them.)
 */
function NewSession({
  teamId,
  visibility,
  open,
  onClose,
  onCreated,
}: {
  teamId: string;
  /** M53: `team` starts one the organization reads along; `private`, an individual one. */
  visibility: 'private' | 'team';
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
          const s = await sessionsApi.create(title.trim(), teamId, visibility);
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
  const [people, setPeople] = useState<{ id: string; displayName: string; avatarUrl?: string | null }[] | null>(null);
  if (!people) {
    return (
      <button className="side-item side-more side-button" onClick={() => chats.people().then(setPeople).catch(() => setPeople([]))}>
        + New message
      </button>
    );
  }
  return (
    <div className="side-picker">
      {people.length === 0 && <p className="side-empty">Nobody shares an organization with you yet.</p>}
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
          <span className="side-icon" aria-hidden>
            <Face name={p.displayName} seed={p.id} url={p.avatarUrl} size="xs" />
          </span>
          <span className="side-label">{p.displayName}</span>
        </button>
      ))}
      <button className="side-item side-more side-button" onClick={() => setPeople(null)}>
        Cancel
      </button>
    </div>
  );
}

/** A page of a place, one row: Integrations and Settings list theirs here. */
function PageLink({ to, label, onNavigate, end }: { to: string; label: string; onNavigate: () => void; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
      <span className="side-label">{label}</span>
    </NavLink>
  );
}

export function Sidebar({ place, onNavigate }: { place: Place; onNavigate: () => void }) {
  const { user, signOut } = useAuth();
  const { sessions, teams, team, selectTeam, needsYou } = useWorkspace();
  const navigate = useNavigate();
  // M42: another team has a room that needs you.
  const elsewhere = (teamId: string) => sessions.reduce((n, s) => n + (s.team?.id === teamId ? needsYou(s) : 0), 0);
  const otherTeamsNeedYou = teams.some((t) => t.id !== team?.id && elsewhere(t.id) > 0);

  const { refresh } = useWorkspace();
  const active = sessions.filter((s) => s.status === 'active');
  // Sessions and chats are different things (ADR 0026): each is a place of its own (ADR 0048).
  // M53 (ADR 0051): every session is in an organization. Individual = only you in it.
  const work = active.filter((s) => (s.kind ?? 'session') === 'session' && s.team?.id === team?.id);
  // M55 (ADR 0053): in Self, the shared ones are one-off sessions, and so are the
  // sessions you are in whose organization is none of yours (the other side of one).
  const foreign = team?.own ? active.filter((s) => (s.kind ?? 'session') === 'session' && s.team && !teams.some((t) => t.id === s.team!.id)) : [];
  const teamSessions = team ? [...work.filter((s) => !s.individual), ...foreign].sort(byActivity) : [];
  const personal = team ? work.filter((s) => s.individual).sort(byActivity) : [];
  const teamChats = team
    ? active.filter((s) => s.kind === 'chat' && s.team?.id === team.id).sort((a, b) => a.title.localeCompare(b.title))
    : [];
  const directs = active.filter((s) => s.kind === 'direct').sort(byActivity);
  const [creating, setCreating] = useState<'team' | 'individual' | null>(null);
  const open = (s: SessionSummary) => {
    setCreating(null);
    refresh();
    navigate(`/o/${s.ownerSlug}/s/${s.publicId}`);
    onNavigate();
  };
  const rooms = place === 'sessions' || place === 'chats';

  return (
    <nav className="sidebar" aria-label={PLACE_LABEL[place]}>
      <div className="side-top">
        {teams.length > 0 ? (
          <Select
            tone="sidebar"
            label="Organization"
            value={team?.id ?? ''}
            options={teams.map((t) => ({
              value: t.id,
              label: t.name,
              description: `${t.memberCount} ${t.memberCount === 1 ? 'member' : 'members'}${elsewhere(t.id) ? ` · ${elsewhere(t.id)} need${elsewhere(t.id) === 1 ? 's' : ''} you` : ''}`,
              leading: <TeamInitial name={t.name} />,
            }))}
            onChange={(id) => {
              selectTeam(id || null);
              // A page about the organization follows it; a room does not belong to the new one.
              if (rooms) navigate('/');
              onNavigate();
            }}
          />
        ) : (
          <strong className="side-brand">{PLACE_LABEL[place]}</strong>
        )}
        {teams.length > 0 && otherTeamsNeedYou ? <span className="side-team-dot" role="status" aria-label="Another organization needs you" title="Another organization needs you" /> : null}
        {rooms && <NotifyOffer total={sessions.reduce((n, s) => n + needsYou(s), 0)} />}
        {place === 'sessions' && (
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'side-item on' : 'side-item')} onClick={onNavigate}>
            <span className="side-icon" aria-hidden>⌂</span>
            <span className="side-label">Home</span>
          </NavLink>
        )}
      </div>

      {place === 'sessions' && team && team.own && (
        <section className="side-section" aria-label="One-off sessions">
          {/* M55 (ADR 0053): in Self, a shared session is a one-off session; the + starts one from the home card. */}
          <SectionHead title="One-off sessions" label="Start a one-off session" onAdd={() => { navigate('/?one-off=1'); onNavigate(); }} />
          {teamSessions.length === 0 && <p className="side-empty">Sessions with one person, by link. None yet.</p>}
          {teamSessions.map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <NavLink
            to={`/teams/${team.id}/sessions`}
            className={({ isActive }) => (isActive ? 'side-item side-more on' : 'side-item side-more')}
            onClick={onNavigate}
          >
            All, archived too
          </NavLink>
        </section>
      )}

      {place === 'sessions' && team && !team.own && (
        <section className="side-section" aria-label="Organization sessions">
          <SectionHead title="Organization sessions" label={`New session ${team.name} can read along`} onAdd={() => setCreating('team')} />
          <NewSession teamId={team.id} visibility="team" open={creating === 'team'} onClose={() => setCreating(null)} onCreated={open} />
          {teamSessions.length === 0 && <p className="side-empty">None yet: sessions {team.name} reads along, or with more than one person.</p>}
          {teamSessions.map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <NavLink
            to={`/teams/${team.id}/sessions`}
            className={({ isActive }) => (isActive ? 'side-item side-more on' : 'side-item side-more')}
            onClick={onNavigate}
          >
            All, archived too
          </NavLink>
        </section>
      )}

      {place === 'sessions' && team && (
        <section className="side-section" aria-label="Individual sessions">
          <SectionHead title="Individual sessions" label={`New individual session in ${team.name}`} onAdd={() => setCreating('individual')} />
          <NewSession teamId={team.id} visibility="private" open={creating === 'individual'} onClose={() => setCreating(null)} onCreated={open} />
          {personal.length === 0 && <p className="side-empty">Sessions only you are in show here.</p>}
          {personal.map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <NavLink to={`/teams/${team.id}/sessions?individual=1`} className="side-item side-more" onClick={onNavigate}>
            All, archived too
          </NavLink>
        </section>
      )}

      {/* ADR 0051: Self has no Chats place at all; the shell never lands here in Self. */}
      {place === 'chats' && team && !team.own && (
        <section className="side-section" aria-label="Organization chats">
          <h2>Organization chats</h2>
          {teamChats.map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <AddChat teamId={team.id} onAdded={open} />
        </section>
      )}

      {place === 'chats' && team && !team.own && (
        <section className="side-section" aria-label="Direct messages">
          <h2>Direct messages</h2>
          {directs.map((s) => (
            <SessionLink key={s.publicId} s={s} onNavigate={onNavigate} />
          ))}
          <NewDirect onOpened={open} />
        </section>
      )}

      {place === 'integrations' && (
        <section className="side-section" aria-label="Integrations">
          <h2>Connections</h2>
          <PageLink to="/integrations" end label={team?.own ? 'Yours' : 'Personal'} onNavigate={onNavigate} />
          {/* ADR 0051: inside Self there is no organization list beside your own. */}
          {team && !team.own && <PageLink to="/integrations/organization" label={`${team.name}'s`} onNavigate={onNavigate} />}
        </section>
      )}

      {place === 'settings' && (
        <section className="side-section" aria-label="Settings">
          <h2>Settings</h2>
          {/* M68 (ADR 0062): Self is one person, so it has no People. */}
          {team && !team.own && <PageLink to="/settings/people" label="People" onNavigate={onNavigate} />}
          {/* M60 (ADR 0058): who did what, per organization. */}
          {team && <PageLink to="/settings/activity" label="Activity" onNavigate={onNavigate} />}
          {team?.own && <PageLink to="/settings/organizations" label="Organizations" onNavigate={onNavigate} />}
          <PageLink to="/settings/devices" label="Your devices" onNavigate={onNavigate} />
          <PageLink to="/settings/appearance" label="Appearance" onNavigate={onNavigate} />
          {/* M58 (ADR 0057): who you are, and the door out. */}
          <PageLink to="/settings/account" label="Account" onNavigate={onNavigate} />
        </section>
      )}

      {place === 'settings' && (
        <div className="side-bottom">
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
      )}
    </nav>
  );
}
