/**
 * The frame every signed-in page lives in (M28): on the left the icon rail of
 * places and the list for the place you are in (M51, ADR 0048), the page on
 * the right. On a narrow screen the rail and the list are one drawer.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';
import { placeOfPath, Rail, type Place } from './Rail.tsx';
import { useWorkspace } from './workspace.tsx';

/** M36: the sidebar's width — dragged, remembered, bounded. */
const SIDE = { min: 200, max: 420, initial: 248, step: 16, key: 'fabrikka.sidebarWidth' };
const clampSide = (w: number) => Math.round(Math.min(SIDE.max, Math.max(SIDE.min, w)));

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDE.key));
    return n ? clampSide(n) : SIDE.initial;
  } catch {
    // Storage can be blocked; the default width is fine.
    return SIDE.initial;
  }
}

/** Drag the sidebar's edge, like Slack's. Double-click resets; ← → nudge it. */
function useSidebarWidth() {
  const [width, setWidth] = useState(storedWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; w: number } | null>(null);

  const commit = useCallback((w: number) => {
    const next = clampSide(w);
    setWidth(next);
    try {
      localStorage.setItem(SIDE.key, String(next));
    } catch {
      // A convenience, not state: fine to lose.
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    start.current = { x: e.clientX, w: width };
    try {
      // Keeps the drag when the pointer outruns the thin handle.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some pointer sources can't be captured; the drag still works over the handle.
    }
    setDragging(true);
    document.body.classList.add('resizing-sidebar');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (start.current) setWidth(clampSide(start.current.w + e.clientX - start.current.x));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    commit(start.current.w + e.clientX - start.current.x);
    start.current = null;
    setDragging(false);
    document.body.classList.remove('resizing-sidebar');
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const by = { ArrowLeft: -SIDE.step, ArrowRight: SIDE.step }[e.key];
    if (by) {
      e.preventDefault();
      commit(width + by);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      commit(e.key === 'Home' ? SIDE.min : SIDE.max);
    }
  };

  const handle = (
    <div
      className={dragging ? 'side-resize dragging' : 'side-resize'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDE.min}
      aria-valuemax={SIDE.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => commit(SIDE.initial)}
      onKeyDown={onKeyDown}
    />
  );
  return { width, handle };
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const side = useSidebarWidth();
  const location = useLocation();
  const navigate = useNavigate();
  const { sessions, teams, team, selectTeam, refresh } = useWorkspace();

  /*
   * ADR 0048: the place follows the page. Clicking another place while a room
   * (or the home) is open changes the list, not the page: that pick is kept
   * for this address only, so the next page shows its own place again. From
   * any other page, Sessions and Chats go home with that list shown.
   */
  const [pick, setPick] = useState<{ path: string; place: Place } | null>(null);
  const asked = (location.state as { place?: Place } | null)?.place;
  const place: Place = pick?.path === location.pathname ? pick.place : location.pathname === '/' && asked ? asked : placeOfPath(location.pathname, sessions);
  const pickPlace = (p: Place) => {
    const isRoom = /^\/o\//.test(location.pathname);
    if (p === 'integrations' || p === 'settings') {
      if (place !== p) navigate(`/${p}`);
      setDrawer(false);
    } else if (isRoom || location.pathname === '/') {
      setPick({ path: location.pathname, place: p });
    } else {
      navigate('/', { state: { place: p } });
    }
  };
  // ADR 0041: the last write a deployment refused, shown until dismissed.
  const [gated, setGated] = useState<{ text: string; url?: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setGated((e as CustomEvent<{ text: string; url?: string }>).detail);
    window.addEventListener('fabrikka:gated', on);
    return () => window.removeEventListener('fabrikka:gated', on);
  }, []);
  const notice = gated ? { ...gated, tone: 'attention' as const } : (team?.notice ?? null);

  // Navigating is a good moment to refresh the lists (a new message moves a
  // session up), and opening another team's session switches team, the way a
  // chat tool switches workspace when you follow a link.
  useEffect(() => {
    refresh();
  }, [location.pathname, refresh]);
  useEffect(() => {
    const m = /^\/o\/([^/]+)\/s\/([^/]+)/.exec(location.pathname);
    if (!m) return;
    const open = sessions.find((s) => s.ownerSlug === m[1] && s.publicId === m[2]);
    if (!open?.team || open.team.id === team?.id) return;
    // M55 (ADR 0053): a one-off session you were invited to belongs to someone else's Self: it lives under yours.
    const mine = teams.find((t) => t.id === open.team!.id);
    const own = teams.find((t) => t.own);
    if (mine) selectTeam(mine.id);
    else if (own && own.id !== team?.id) selectTeam(own.id);
  }, [location.pathname, sessions, teams, team, selectTeam]);

  return (
    <div className={drawer ? 'shell drawer-open' : 'shell'} style={{ '--side-w': `${side.width}px` } as React.CSSProperties}>
      <div className="side-stack">
        <Rail place={place} onPick={pickPlace} />
        <Sidebar place={place} onNavigate={() => setDrawer(false)} />
      </div>
      {side.handle}
      {drawer && <button className="shell-backdrop" aria-label="Close menu" onClick={() => setDrawer(false)} />}
      <div className="shell-main">
        <button className="shell-menu" aria-label="Open menu" onClick={() => setDrawer(true)}>
          ☰
        </button>
        {notice && (
          <div className={`team-notice ${notice.tone}`} role="status">
            {notice.url ? <a href={notice.url}>{notice.text}</a> : <span>{notice.text}</span>}
            {gated && (
              <button className="team-notice-close" aria-label="Dismiss" onClick={() => setGated(null)}>
                ×
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
