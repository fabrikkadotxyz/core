/**
 * Onboarding (M47): the welcome (pick a look, once per account) and Get
 * started's five steps. Each step is derived from the records it describes,
 * like unread and "needs you"; only "welcomed" and "dismissed" are stored.
 * See docs/roadmap.md, M47.
 */
import type { Database } from '@fabrikka/db';
import { users } from '@fabrikka/db';
import { eq, sql } from 'drizzle-orm';

export type StepId = 'computer' | 'room' | 'agent' | 'invite' | 'integration';

export interface GettingStarted {
  /** The welcome was shown; false = show it now. */
  welcomed: boolean;
  dismissed: boolean;
  steps: { id: StepId; done: boolean; optional: boolean }[];
  /** A room of yours to bring an agent into (step 3), newest first; null if none. */
  room: { ownerSlug: string; publicId: string } | null;
}

export async function gettingStarted(db: Database, userId: string): Promise<GettingStarted> {
  const [row] = (await db.execute(sql`
    SELECT
      u.welcomed_at IS NOT NULL AS welcomed,
      u.getting_started_dismissed_at IS NOT NULL AS dismissed,
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
  };
}

export async function markWelcomed(db: Database, userId: string): Promise<void> {
  await db.update(users).set({ welcomedAt: sql`coalesce(${users.welcomedAt}, now())` }).where(eq(users.id, userId));
}

export async function dismissGettingStarted(db: Database, userId: string): Promise<void> {
  await db.update(users).set({ gettingStartedDismissedAt: sql`now()` }).where(eq(users.id, userId));
}
