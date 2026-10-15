/**
 * The icon rail (M51, ADR 0048): four places at the far left of every signed-in
 * page — Sessions, Chats, Integrations, Settings — with the Fabrikka mark
 * (Home) above them and the account below. Fixed width, never scrolls. The list
 * beside it (Sidebar.tsx) shows the place you are in.
 *
 * Sessions and Chats carry M42's "needs you" number for the rooms of their
 * kind, and a dot when one is unread: the rail is where the signal lives when
 * the room is in another place.
 */
import { Link } from 'react-router-dom';
import type { SessionSummary } from '@fabrikka/types';
import { Mark } from '../components/Mark.tsx';
import { useAuth } from '../auth-context.tsx';
import { useWorkspace } from './workspace.tsx';

export type Place = 'sessions' | 'chats' | 'integrations' | 'settings';
export const PLACES: Place[] = ['sessions', 'chats', 'integrations', 'settings'];
export const PLACE_LABEL: Record<Place, string> = { sessions: 'Sessions', chats: 'Chats', integrations: 'Integrations', settings: 'Settings' };

/** Which place a room belongs to (ADR 0026): chats and direct messages under Chats. */
export const placeOfRoom = (s: Pick<SessionSummary, 'kind'>): Place => (s.kind === 'chat' || s.kind === 'direct' ? 'chats' : 'sessions');

/** The place a page belongs to. A room's is its kind's; a room not yet listed counts as a session. */
export function placeOfPath(pathname: string, sessions: SessionSummary[]): Place {
  if (pathname.startsWith('/integrations')) return 'integrations';
  if (pathname.startsWith('/settings')) return 'settings';
  const m = /^\/o\/([^/]+)\/s\/([^/]+)/.exec(pathname);
  if (m) {
    const room = sessions.find((s) => s.ownerSlug === m[1] && s.publicId === m[2]);
    return room ? placeOfRoom(room) : 'sessions';
  }
  return 'sessions';
}

/* Line icons, 24-unit grid, drawn in currentColor. */
const ICON: Record<Place, React.ReactElement> = {
  sessions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  ),
  chats: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 4H4v12h5l3 3 3-3h5z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  ),
  integrations: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  ),
};

export function Rail({ place, onPick }: { place: Place; onPick: (p: Place) => void }) {
  const { user } = useAuth();
  const { sessions, needsYou } = useWorkspace();
  const active = sessions.filter((s) => s.status === 'active');
  const count = (p: Place) => (p === 'sessions' || p === 'chats' ? active.filter((s) => placeOfRoom(s) === p).reduce((n, s) => n + needsYou(s), 0) : 0);
  const unread = (p: Place) => (p === 'sessions' || p === 'chats') && active.some((s) => placeOfRoom(s) === p && s.unread);
  const initial = (user?.displayName || user?.ownerSlug || '?').slice(0, 1).toUpperCase();

  return (
    <nav className="rail-nav" aria-label="Places">
      <Link to="/" className="rail-home" title="Home" aria-label="Home" onClick={() => onPick('sessions')}>
        <Mark size={26} />
      </Link>
      {PLACES.map((p) => {
        const n = count(p);
        const title = n ? `${PLACE_LABEL[p]} — ${n} need${n === 1 ? 's' : ''} you` : PLACE_LABEL[p];
        return (
          <button
            key={p}
            type="button"
            className={`rail-place${place === p ? ' on' : ''}`}
            aria-current={place === p ? 'page' : undefined}
            aria-label={title}
            title={title}
            onClick={() => onPick(p)}
          >
            <span className="rail-icon" aria-hidden>
              {ICON[p]}
              {n > 0 ? <span className="rail-count">{n > 99 ? '99+' : n}</span> : unread(p) ? <span className="rail-dot" /> : null}
            </span>
            <span className="rail-label" aria-hidden>
              {PLACE_LABEL[p]}
            </span>
          </button>
        );
      })}
      <span className="rail-spacer" />
      <button type="button" className="rail-account" title={`@${user?.ownerSlug ?? ''} · Settings`} aria-label="Your account, in Settings" onClick={() => onPick('settings')}>
        {initial}
      </button>
    </nav>
  );
}
