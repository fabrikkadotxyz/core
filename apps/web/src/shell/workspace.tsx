/**
 * What the sidebar and the home share (M28): your sessions, your teams, and the
 * team you're looking at. One source, so the sidebar never disagrees with the
 * page next to it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionSummary, TeamSummary } from '@fabrikka/types';
import { sessions as sessionsApi, teams as teamsApi } from '../api.ts';

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
}

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
    Promise.all([sessionsApi.list(), teamsApi.list()])
      .then(([s, t]) => {
        setSessions(s);
        setTeams(t);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);
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
    () => ({ sessions, teams, teamId: team?.id ?? null, team, selectTeam, refresh, loaded }),
    [sessions, teams, team, selectTeam, refresh, loaded],
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
