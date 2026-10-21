/**
 * Teams: a list of people who already trust each other, plus nothing else.
 * See ADR 0025 and docs/data-model.md (M21).
 *
 * A team decides who a session owner can add without a link. It never makes a
 * session visible by itself, and being on a team reveals no teammate's sessions.
 */
import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { sessionMembers, sessions, teamMembers, teams, users } from '@fabrikka/db';
import type { TeamDetail, TeamMember, TeamRole, TeamSummary } from '@fabrikka/types';
import { addMember } from './sessions.ts';
import { ensureGeneral, joinTeamChats } from './chats.ts';
import { accountMark } from './leaving.ts';
import { avatarUrl } from './avatars.ts';

const MAX_NAME = 80;

export class TeamError extends Error {}

export async function createTeam(db: Database, userId: string, name: string): Promise<TeamSummary> {
  const trimmed = name.trim().slice(0, MAX_NAME);
  if (!trimmed) throw new TeamError('an organization name is required');
  return db.transaction(async (tx) => {
    const [team] = await tx.insert(teams).values({ name: trimmed, createdByUserId: userId }).returning();
    await tx.insert(teamMembers).values({ teamId: team!.id, userId, role: 'owner' });
    return { id: team!.id, name: team!.name, role: 'owner' as const, memberCount: 1 };
  }).then(async (t) => {
    // M29: every team starts with #general.
    await ensureGeneral(db, t.id);
    return t;
  });
}

export async function listTeamsForUser(db: Database, userId: string): Promise<TeamSummary[]> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      role: teamMembers.role,
      memberCount: sql<number>`(select count(*) from ${teamMembers} tm where tm.team_id = ${teams.id})`,
      ownOf: teams.ownOfUserId,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    // M53: your own organization first, then the others by name.
    .orderBy(sql`case when ${teams.ownOfUserId} = ${userId} then 0 else 1 end`, asc(teams.name));
  return rows.map(({ ownOf, ...r }) => ({ ...r, role: r.role as TeamRole, memberCount: Number(r.memberCount), own: ownOf === userId }));
}

/** M53 (ADR 0051): the account's own organization. Every account has one; null only for a row older than the migration that made them. */
export async function ownOrganizationOf(db: Database, userId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.ownOfUserId, userId)).limit(1);
  return row ?? null;
}

/** The caller's role on a team, or null — which every route must answer with 404. */
export async function teamRole(db: Database, teamId: string, userId: string): Promise<TeamRole | null> {
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) return null;
  const [row] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return (row?.role as TeamRole | undefined) ?? null;
}

/** The columns a team member is built from, and the building: one shape for the roster and the member list. */
const memberColumns = {
  userId: users.id,
  displayName: users.displayName,
  email: users.email,
  role: teamMembers.role,
  deactivatedAt: users.deactivatedAt,
  deletedAt: users.deletedAt,
  avatarKey: users.avatarKey,
};

// M58: a member whose account left is listed with the mark. M67: with their picture.
function toTeamMember({ deactivatedAt, deletedAt, avatarKey, ...r }: { userId: string; displayName: string; email: string; role: string; deactivatedAt: Date | null; deletedAt: Date | null; avatarKey: string | null }): TeamMember {
  return { ...r, role: r.role as TeamRole, account: accountMark({ deactivatedAt, deletedAt }), avatarUrl: avatarUrl(avatarKey) };
}

export async function listTeamMembers(db: Database, teamId: string): Promise<TeamMember[]> {
  const rows = await db
    .select(memberColumns)
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(users.displayName));
  return rows.map(toTeamMember);
}

export async function getTeam(db: Database, teamId: string, userId: string): Promise<TeamDetail | null> {
  const role = await teamRole(db, teamId, userId);
  if (!role) return null;
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) return null;
  return { id: team.id, name: team.name, role, members: await listTeamMembers(db, teamId) };
}

/** Idempotent: redeeming a second invite to a team you're on changes nothing. */
export async function addTeamMember(
  db: Database,
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<{ id: string; name: string }> {
  await db.insert(teamMembers).values({ teamId, userId, role }).onConflictDoNothing();
  // M29: joining a team brings you into every one of its chats.
  await ensureGeneral(db, teamId);
  await joinTeamChats(db, teamId, userId);
  const [team] = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1);
  return team!;
}

/**
 * Take someone off a team, and with it exactly the session access the team gave
 * them. Access from a direct invite stays. The last owner can't be removed: a
 * team nobody can manage is worse than one with a reluctant owner.
 */
export async function removeTeamMember(db: Database, teamId: string, userId: string): Promise<void> {
  // M53 (ADR 0051): nobody leaves their own organization; the account is never without one.
  const [own] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.ownOfUserId, userId))).limit(1);
  if (own) throw new TeamError('this is your own organization: you cannot leave it');
  const owners = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')));
  if (owners.length === 1 && owners[0]!.userId === userId) {
    throw new TeamError('the last owner cannot leave — make someone else an owner first');
  }
  await db.transaction(async (tx) => {
    await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    await tx
      .delete(sessionMembers)
      .where(and(eq(sessionMembers.userId, userId), eq(sessionMembers.viaTeamId, teamId)));
  });
}

/** The team a session belongs to, if any. */
export async function sessionTeam(db: Database, sessionId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: teams.id, name: teams.name })
    .from(sessions)
    .innerJoin(teams, eq(teams.id, sessions.teamId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

// ADR 0050: a session's organization is fixed at creation; there is no setSessionTeam.

/** Teammates who aren't in the session yet — who the owner can add without a link. */
export async function roster(db: Database, sessionId: string): Promise<TeamMember[]> {
  const team = await sessionTeam(db, sessionId);
  if (!team) return [];
  const inSession = db
    .select({ userId: sessionMembers.userId })
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, sessionId));
  const rows = await db
    .select(memberColumns)
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, team.id), notInArray(teamMembers.userId, inSession)))
    .orderBy(asc(users.displayName));
  return rows.map(toTeamMember);
}

/** Add a teammate from the roster. Refused for anyone not on the session's team. */
export async function addFromRoster(db: Database, sessionId: string, userId: string): Promise<void> {
  const team = await sessionTeam(db, sessionId);
  if (!team) throw new TeamError('this session is not in an organization');
  if (!(await teamRole(db, team.id, userId))) throw new TeamError('that person is not in this organization');
  const [user] = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, userId));
  await addMember(db, sessionId, user!, 'member', { viaTeamId: team.id });
}

/** Where each member's access came from, for the Members panel. */
export async function membershipOrigins(db: Database, sessionId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ userId: sessionMembers.userId, teamId: sessionMembers.viaTeamId })
    .from(sessionMembers)
    .where(and(eq(sessionMembers.sessionId, sessionId), isNotNull(sessionMembers.viaTeamId)));
  return new Map(rows.map((r) => [r.userId, r.teamId!]));
}

