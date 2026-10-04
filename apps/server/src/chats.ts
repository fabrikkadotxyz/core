/**
 * Team chats and direct chats (M29): a light kind of session (ADR 0026).
 *
 * Team chat membership is eager and always through the team (`via_team_id`):
 * creating a team creates #general, creating a chat adds every member, and
 * joining a team adds the joiner to every chat — so leaving the team (M21)
 * removes exactly these. A direct chat is one per pair of people who share a team.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { sessions, teamMembers, teams, users } from '@fabrikka/db';
import type { SessionSummary } from '@fabrikka/types';
import { addMember, createSession, listSessionsForUser, resolveSessionForUser } from './sessions.ts';

export class ChatError extends Error {}

const MAX_NAME = 60;

async function userById(db: Database, id: string) {
  const [u] = await db
    .select({ id: users.id, displayName: users.displayName, ownerSlug: users.ownerSlug })
    .from(users)
    .where(eq(users.id, id));
  return u ?? null;
}

/** A chat name: lowercase words joined by dashes, like a channel. */
export function chatName(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME);
}

/** Create a team chat; every team member is in it, through the team. */
export async function createChat(
  db: Database,
  opts: { teamId: string; userId: string; name: string },
): Promise<SessionSummary> {
  const name = chatName(opts.name);
  if (!name) throw new ChatError('a chat needs a name');
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.teamId, opts.teamId), eq(sessions.kind, 'chat'), eq(sessions.title, name)))
    .limit(1);
  if (existing.length) throw new ChatError(`#${name} already exists`);

  const owner = await userById(db, opts.userId);
  const created = await createSession(db, owner!, name, { teamId: opts.teamId, kind: 'chat' });
  const s = await resolveSessionForUser(db, created.ownerSlug, created.publicId, opts.userId);
  const members = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, opts.teamId));
  for (const m of members) {
    if (m.id !== opts.userId) await addMember(db, s!.id, m, 'member', { viaTeamId: opts.teamId });
  }
  return created;
}

/** Every team has #general. Created with the team, or on first look for older teams. */
export async function ensureGeneral(db: Database, teamId: string): Promise<void> {
  const has = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.teamId, teamId), eq(sessions.kind, 'chat'), eq(sessions.title, 'general')))
    .limit(1);
  if (has.length) return;
  const [team] = await db.select({ createdBy: teams.createdByUserId }).from(teams).where(eq(teams.id, teamId));
  if (!team) return;
  await createChat(db, { teamId, userId: team.createdBy, name: 'general' }).catch(() => {});
}

/** Someone joined the team: they're in every one of its chats, through the team. */
export async function joinTeamChats(db: Database, teamId: string, userId: string): Promise<void> {
  const user = await userById(db, userId);
  if (!user) return;
  const chats = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.teamId, teamId), eq(sessions.kind, 'chat')));
  for (const c of chats) await addMember(db, c.id, user, 'member', { viaTeamId: teamId });
}

/** The team's chats, for someone on it. */
export async function listTeamChats(db: Database, teamId: string, userId: string): Promise<SessionSummary[]> {
  await ensureGeneral(db, teamId);
  return (await listSessionsForUser(db, userId)).filter((s) => s.kind === 'chat' && s.team?.id === teamId);
}

/** Do two people share a team? Only then may one open a direct chat with the other. */
async function shareATeam(db: Database, a: string, b: string): Promise<boolean> {
  const mine = db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, a));
  const shared = await db
    .select({ id: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, b), inArray(teamMembers.teamId, mine)))
    .limit(1);
  return shared.length > 0;
}

/** Open the direct chat between two people, creating it the first time. */
export async function openDirect(db: Database, userId: string, otherUserId: string): Promise<SessionSummary> {
  if (userId === otherUserId) throw new ChatError("that's you");
  const other = await userById(db, otherUserId);
  // Someone you share no team with is indistinguishable from nobody.
  if (!other || !(await shareATeam(db, userId, otherUserId))) throw new ChatError('no such person');
  const key = [userId, otherUserId].sort().join(':');
  const found = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.directKey, key)).limit(1);
  if (!found.length) {
    const me = await userById(db, userId);
    try {
      const created = await createSession(db, me!, 'direct', { kind: 'direct', directKey: key });
      const s = await resolveSessionForUser(db, created.ownerSlug, created.publicId, userId);
      await addMember(db, s!.id, other, 'member');
    } catch {
      // Both opened it at the same moment: the unique key let one through.
    }
  }
  const mine = await listSessionsForUser(db, userId);
  const [row] = await db.select({ publicId: sessions.publicId }).from(sessions).where(eq(sessions.directKey, key));
  return mine.find((s) => s.publicId === row!.publicId)!;
}

/** Teammates you could open a direct chat with, across your teams. */
export async function directCandidates(db: Database, userId: string) {
  const mine = db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId));
  const rows = await db
    .selectDistinct({ id: users.id, displayName: users.displayName })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(inArray(teamMembers.teamId, mine));
  return rows.filter((r) => r.id !== userId).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
