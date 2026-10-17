/**
 * Onboarding (M47): the welcome (pick a look, once per account) and Get
 * started's five steps. Each step is derived from the records it describes,
 * like unread and "needs you"; only "welcomed" and "dismissed" are stored.
 * See docs/roadmap.md, M47.
 */
import type { Database } from '@fabrikka/db';
import { users } from '@fabrikka/db';
import { AGENT_TOOLS, WANTED_AGENTS, WANTED_MAX, WANTED_NAME_MAX } from '@fabrikka/types';
import { eq, sql } from 'drizzle-orm';

export type StepId = 'computer' | 'room' | 'agent' | 'invite' | 'integration';

export interface GettingStarted {
  /** The welcome was shown; false = show it now. */
  welcomed: boolean;
  dismissed: boolean;
  steps: { id: StepId; done: boolean; optional: boolean }[];
  /** A room of yours to bring an agent into (step 3), newest first; null if none. */
  room: { ownerSlug: string; publicId: string } | null;
  /** 2026-10-17: the agent tools they said they use (AGENT_TOOLS ids and/or 'other'); null until asked. */
  agents: string[] | null;
  /** 2026-10-17: agents they wish Fabrikka ran (WANTED_AGENTS ids, or a short free name). */
  wanted: string[];
}

/** What the welcome may record as your agents: registry ids and/or 'other', each once. */
export function validAgentChoices(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((a) => a === 'other' || (typeof a === 'string' && AGENT_TOOLS.some((t) => t.id === a))) && new Set(v).size === v.length;
}

/**
 * What may be wished for: a WANTED_AGENTS id, or a short free name (one line,
 * no control characters). Returns the cleaned list, or null when it is not one.
 */
export function cleanWanted(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > WANTED_MAX) return null;
  const out: string[] = [];
  for (const w of v) {
    if (typeof w !== 'string') return null;
    const t = w.trim();
    if (!t) continue;
    if (t.length > WANTED_NAME_MAX || /[\u0000-\u001f\u007f]/.test(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export async function setPreferredAgents(db: Database, userId: string, agents: string[] | null, wanted?: string[]): Promise<void> {
  await db
    .update(users)
    .set({ preferredAgents: agents, ...(wanted !== undefined ? { wantedAgents: wanted } : {}) })
    .where(eq(users.id, userId));
}

/** `admin agents`: how many people use, and wish for, each tool. Counts only. */
export async function agentCounts(db: Database): Promise<{ used: Record<string, number>; wanted: Record<string, number>; answered: number }> {
  const rows = await db.select({ agents: users.preferredAgents, wanted: users.wantedAgents }).from(users);
  const used: Record<string, number> = {};
  const wanted: Record<string, number> = {};
  let answered = 0;
  for (const r of rows) {
    if (r.agents) answered++;
    for (const a of r.agents ?? []) used[a] = (used[a] ?? 0) + 1;
    for (const w of r.wanted ?? []) {
      const key = WANTED_AGENTS.some((x) => x.id === w) ? w : `other: ${w}`;
      wanted[key] = (wanted[key] ?? 0) + 1;
    }
  }
  return { used, wanted, answered };
}

export async function gettingStarted(db: Database, userId: string): Promise<GettingStarted> {
  const [row] = (await db.execute(sql`
    SELECT
      u.welcomed_at IS NOT NULL AS welcomed,
      u.getting_started_dismissed_at IS NOT NULL AS dismissed,
      u.preferred_agents AS preferred_agents,
      u.wanted_agents AS wanted_agents,
      EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS computer,
      EXISTS (SELECT 1 FROM sessions s WHERE s.owner_id = u.id AND s.kind = 'session') AS room,
      EXISTS (
        SELECT 1 FROM messages m
        JOIN participants p ON p.id = m.author_participant_id
        JOIN session_agents sa ON sa.id = p.session_agent_id
        JOIN agents a ON a.id = sa.agent_id
        WHERE a.owner_id = u.id
      ) AS agent,
      EXISTS (SELECT 1 FROM session_invites i WHERE i.created_by_user_id = u.id)
        OR EXISTS (
          SELECT 1 FROM team_members mine
          JOIN team_members other ON other.team_id = mine.team_id AND other.user_id <> u.id
          WHERE mine.user_id = u.id
        ) AS invite,
      EXISTS (SELECT 1 FROM mcp_servers c WHERE c.owner_id = u.id)
        OR EXISTS (SELECT 1 FROM team_mcp_servers t WHERE t.added_by_user_id = u.id) AS integration,
      (SELECT json_build_object('ownerSlug', u.owner_slug, 'publicId', s.public_id)
         FROM sessions s WHERE s.owner_id = u.id AND s.kind = 'session' AND s.status = 'active'
         ORDER BY s.created_at DESC LIMIT 1) AS latest_room
    FROM users u
    WHERE u.id = ${userId}
  `)) as unknown as Record<string, unknown>[];
  const r = row ?? {};
  const done = (k: string) => r[k] === true;
  return {
    welcomed: done('welcomed'),
    dismissed: done('dismissed'),
    steps: [
      { id: 'computer', done: done('computer'), optional: false },
      { id: 'room', done: done('room'), optional: false },
      { id: 'agent', done: done('agent'), optional: false },
      { id: 'invite', done: done('invite'), optional: false },
      { id: 'integration', done: done('integration'), optional: true },
    ],
    room: (r.latest_room as GettingStarted['room']) ?? null,
    // `agent` is taken by step 3's flag above; the preference has its own name.
    agents: Array.isArray(r.preferred_agents) ? (r.preferred_agents as string[]) : null,
    wanted: Array.isArray(r.wanted_agents) ? (r.wanted_agents as string[]) : [],
  };
}

export async function markWelcomed(db: Database, userId: string): Promise<void> {
  await db.update(users).set({ welcomedAt: sql`coalesce(${users.welcomedAt}, now())` }).where(eq(users.id, userId));
}

export async function dismissGettingStarted(db: Database, userId: string): Promise<void> {
  await db.update(users).set({ gettingStartedDismissedAt: sql`now()` }).where(eq(users.id, userId));
}
