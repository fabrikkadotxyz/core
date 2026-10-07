/**
 * The frame every signed-in page lives in (M28): the sidebar on the left, the
 * page on the right. On a narrow screen the sidebar is a drawer.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';
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
  const { sessions, team, selectTeam, refresh } = useWorkspace();

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
    if (open?.team && open.team.id !== team?.id) selectTeam(open.team.id);
  }, [location.pathname, sessions, team, selectTeam]);

  return (
    <div className={drawer ? 'shell drawer-open' : 'shell'} style={{ '--side-w': `${side.width}px` } as React.CSSProperties}>
      <Sidebar onNavigate={() => setDrawer(false)} />
      {side.handle}
      {drawer && <button className="shell-backdrop" aria-label="Close menu" onClick={() => setDrawer(false)} />}
      <div className="shell-main">
        <button className="shell-menu" aria-label="Open menu" onClick={() => setDrawer(true)}>
          ☰
        </button>
        {children}
      </div>
    </div>
  );
}
