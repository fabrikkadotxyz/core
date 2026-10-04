/**
 * The frame every signed-in page lives in (M28): the sidebar on the left, the
 * page on the right. On a narrow screen the sidebar is a drawer.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';
import { useWorkspace } from './workspace.tsx';

export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
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
    <div className={drawer ? 'shell drawer-open' : 'shell'}>
      <Sidebar onNavigate={() => setDrawer(false)} />
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
