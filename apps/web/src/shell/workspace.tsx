/**
 * What the sidebar and the home share (M28): your sessions, your teams, and the
 * team you're looking at. One source, so the sidebar never disagrees with the
 * page next to it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { PersonEvent, SessionSummary, TeamSummary } from '@fabrikka/types';
import { sessions as sessionsApi, teams as teamsApi } from '../api.ts';
import { showNotification, showTotal } from '../notify.ts';

const TEAM_KEY = 'fabrikka.team';

interface Workspace {
  sessions: SessionSummary[];
  teams: TeamSummary[];
  /** The team the switcher shows. Null when you're on no team. */
  teamId: string | null;
  team: TeamSummary | null;
  selectTeam: (id: string | null) => void;
  refresh: () => void;
  loaded: boolean;
  /** M42: what needs you in a room, as shown: 0 for the room in front of you. */
  needsYou: (s: SessionSummary) => number;
}

const pathOf = (s: Pick<SessionSummary, 'ownerSlug' | 'publicId'>) => `/o/${s.ownerSlug}/s/${s.publicId}`;

const Ctx = createContext<Workspace | null>(null);

function stored(): string | null {
  try {
    return localStorage.getItem(TEAM_KEY);
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [teamId, setTeamId] = useState<string | null>(stored);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    // Teams first: listing them makes sure each has its #general (M29).
    (async () => {
      const t = await teamsApi.list();
      const s = await sessionsApi.list();
      setTeams(t);
      setSessions(s);
    })()
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);

  /*
   * M42 (ADR 0037): one stream per person. Counts change in place; a room we
   * don't have yet (someone just added you) reloads the list. Reconnects after
   * a drop, with a pause so a dead server isn't hammered.
   */
  const navigate = useNavigate();
  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/api/me/stream`);
      ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data)) as PersonEvent;
        if (event.type === 'attention') {
          setSessions((list) => {
            const i = list.findIndex((s) => s.publicId === event.publicId && s.ownerSlug === event.ownerSlug);
            if (i === -1) {
              refresh();
              return list;
            }
            const was = list[i]!;
            const next = [...list];
            next[i] = { ...was, unread: event.unread, needsYou: event.needsYou, lastActivityAt: event.unread && !was.unread ? new Date().toISOString() : was.lastActivityAt };
            return next;
          });
        } else if (event.type === 'notify') {
          showNotification(event, (path) => navigate(path));
        } else if (event.type === 'stream.error') {
          closed = true;
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [navigate, refresh]);

  // The room in front of you never counts: you're looking at it.
  const location_ = useLocation();
  const here = location_.pathname.match(/^\/o\/[^/]+\/s\/[^/]+/)?.[0] ?? null;
  const needsYou = useCallback((s: SessionSummary) => (pathOf(s) === here ? 0 : (s.needsYou ?? 0)), [here]);
  const total = sessions.reduce((n, s) => n + needsYou(s), 0);
  useEffect(() => showTotal(total), [total]);
  // Come back to the tab: someone may have written while you were away.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const selectTeam = useCallback((id: string | null) => {
    setTeamId(id);
    try {
      if (id) localStorage.setItem(TEAM_KEY, id);
      else localStorage.removeItem(TEAM_KEY);
    } catch {
      // Remembering the team is a convenience; without storage it still works.
    }
  }, []);

  // A remembered team you've left, or none chosen yet: fall back to the first.
  const team = teams.find((t) => t.id === teamId) ?? teams[0] ?? null;

  const value = useMemo<Workspace>(
    () => ({ sessions, teams, teamId: team?.id ?? null, team, selectTeam, refresh, loaded, needsYou }),
    [sessions, teams, team, selectTeam, refresh, loaded, needsYou],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Workspace {
  const w = useContext(Ctx);
  if (!w) throw new Error('useWorkspace outside WorkspaceProvider');
  return w;
}

/** Most recently active first; the server already sorts, this keeps it explicit. */
export function byActivity(a: SessionSummary, b: SessionSummary): number {
  return (b.lastActivityAt ?? b.createdAt) < (a.lastActivityAt ?? a.createdAt) ? -1 : 1;
}
