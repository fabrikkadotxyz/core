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

const MAX_NAME = 80;

export class TeamError extends Error {}

export async function createTeam(db: Database, userId: string, name: string): Promise<TeamSummary> {
  const trimmed = name.trim().slice(0, MAX_NAME);
  if (!trimmed) throw new TeamError('a team name is required');
  return db.transaction(async (tx) => {
    const [team] = await tx.insert(teams).values({ name: trimmed, createdByUserId: userId }).returning();
    await tx.insert(teamMembers).values({ teamId: team!.id, userId, role: 'owner' });
    return { id: team!.id, name: team!.name, role: 'owner', memberCount: 1 };
  });
}

export async function listTeamsForUser(db: Database, userId: string): Promise<TeamSummary[]> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      role: teamMembers.role,
      memberCount: sql<number>`(select count(*) from ${teamMembers} tm where tm.team_id = ${teams.id})`,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teams.name));
  return rows.map((r) => ({ ...r, role: r.role as TeamRole, memberCount: Number(r.memberCount) }));
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

export async function listTeamMembers(db: Database, teamId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({ userId: users.id, displayName: users.displayName, email: users.email, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(users.displayName));
  return rows.map((r) => ({ ...r, role: r.role as TeamRole }));
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
  const [team] = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1);
  return team!;
}

/**
 * Take someone off a team, and with it exactly the session access the team gave
 * them. Access from a direct invite stays. The last owner can't be removed: a
 * team nobody can manage is worse than one with a reluctant owner.
 */
export async function removeTeamMember(db: Database, teamId: string, userId: string): Promise<void> {
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

/**
 * Put a session in a team, move it, or take it out. Memberships the previous
 * team granted go with it: they came from the team, not from the owner.
 */
export async function setSessionTeam(db: Database, sessionId: string, teamId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId));
    await tx.update(sessions).set({ teamId }).where(eq(sessions.id, sessionId));
    if (before?.teamId && before.teamId !== teamId) {
      await tx
        .delete(sessionMembers)
        .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.viaTeamId, before.teamId)));
    }
  });
}

/** Teammates who aren't in the session yet — who the owner can add without a link. */
export async function roster(db: Database, sessionId: string): Promise<TeamMember[]> {
  const team = await sessionTeam(db, sessionId);
  if (!team) return [];
  const inSession = db
    .select({ userId: sessionMembers.userId })
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, sessionId));
  const rows = await db
    .select({ userId: users.id, displayName: users.displayName, email: users.email, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, team.id), notInArray(teamMembers.userId, inSession)))
    .orderBy(asc(users.displayName));
  return rows.map((r) => ({ ...r, role: r.role as TeamRole }));
}

/** Add a teammate from the roster. Refused for anyone not on the session's team. */
export async function addFromRoster(db: Database, sessionId: string, userId: string): Promise<void> {
  const team = await sessionTeam(db, sessionId);
  if (!team) throw new TeamError('this session is not in a team');
  if (!(await teamRole(db, team.id, userId))) throw new TeamError('that person is not on this team');
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

