/**
 * Where a deployment may say no, explain, and listen (ADR 0041).
 *
 * The core knows nothing about why. A deployment
 * registers checks through the kit; with none registered, everything here is a
 * no-op and the core behaves as it always has.
 */
import type { Database } from '@fabrikka/db';
import { sessions, teamMembers, teams } from '@fabrikka/db';
import { and, count, eq, sql } from 'drizzle-orm';

export type AccountCheck = (ctx: { accounts: number }) => string | null | Promise<string | null>;

export interface WriteContext {
  /** Who is writing: the person, or the person an agent acts for. Null when unknown. */
  userId: string | null;
  /** The room's team, or null for a room outside any team. */
  teamId: string | null;
  /** The room's owner (for a room outside any team), or the person acting. */
  ownerUserId: string;
  /** A short name: message, room, agent, agent-run, upload, context, output, integration, invite, member. */
  action: string;
}
export interface Refusal {
  reason: string;
  url?: string;
}
export type WriteCheck = (ctx: WriteContext) => Refusal | null | Promise<Refusal | null>;

export interface TeamNotice {
  text: string;
  url?: string;
  tone: 'info' | 'attention';
}
export type NoticeProvider = (ctx: { teamId: string; userId: string }) => TeamNotice | null | Promise<TeamNotice | null>;
export type MembersListener = (ctx: { teamId: string; members: number }) => void | Promise<void>;

const accountChecks: AccountCheck[] = [];
const writeChecks: WriteCheck[] = [];
const noticeProviders: NoticeProvider[] = [];
const membersListeners: MembersListener[] = [];

export const register = {
  account: (f: AccountCheck) => void accountChecks.push(f),
  write: (f: WriteCheck) => void writeChecks.push(f),
  notice: (f: NoticeProvider) => void noticeProviders.push(f),
  members: (f: MembersListener) => void membersListeners.push(f),
};

/** Any number: the advisory lock that makes "count accounts" and "create one" one step. */
const ACCOUNTS_LOCK = 41_001;

/**
 * Before an account is created, inside the transaction that creates it. Null
 * to go ahead, or the sentence to refuse with. Without checks, it costs nothing.
 */
export async function checkNewAccount(tx: Database): Promise<string | null> {
  if (!accountChecks.length) return null;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ACCOUNTS_LOCK})`);
  const [row] = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users`);
  const accounts = Number((row as { n?: number } | undefined)?.n ?? 0);
  for (const check of accountChecks) {
    const refusal = await check({ accounts });
    if (refusal) return refusal;
  }
  return null;
}

export const writesGuarded = () => writeChecks.length > 0;

/** Before a write. Null to go ahead; the first refusal otherwise. */
export async function checkWrite(ctx: WriteContext): Promise<Refusal | null> {
  for (const check of writeChecks) {
    const refusal = await check(ctx);
    if (refusal) return refusal;
  }
  return null;
}

/** A room's team and owner, for checkWrite. Null when the room doesn't exist. */
export async function roomScope(db: Database, sessionId: string): Promise<{ teamId: string | null; ownerUserId: string } | null> {
  const [row] = await db
    .select({ teamId: sessions.teamId, ownerUserId: sessions.ownerId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** The same, by the public id in a room's URL. */
export async function roomScopeByPublicId(db: Database, publicId: string): Promise<{ teamId: string | null; ownerUserId: string } | null> {
  const [row] = await db
    .select({ teamId: sessions.teamId, ownerUserId: sessions.ownerId })
    .from(sessions)
    .where(eq(sessions.publicId, publicId))
    .limit(1);
  return row ?? null;
}

/** The notice for one team and one person, or null. The first provider that answers wins. */
export async function noticeFor(teamId: string, userId: string): Promise<TeamNotice | null> {
  for (const provide of noticeProviders) {
    try {
      const notice = await provide({ teamId, userId });
      if (notice) return safeNotice(notice);
    } catch (err) {
      console.warn(`[gates] a team notice failed: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Plain text, short, and a link only to http(s) or a path on this instance. */
function safeNotice(n: TeamNotice): TeamNotice | null {
  const text = String(n.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!text) return null;
  const url = typeof n.url === 'string' && (/^https?:\/\//.test(n.url) || /^\/(?!\/)/.test(n.url)) ? n.url : undefined;
  return { text, ...(url ? { url } : {}), tone: n.tone === 'attention' ? 'attention' : 'info' };
}

/**
 * After a team's membership changed and committed. Never blocks the caller and
 * never undoes anything: a failing listener is logged.
 */
export function membersChanged(db: Database, teamId: string): void {
  if (!membersListeners.length) return;
  void (async () => {
    const [row] = await db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
    const members = Number(row?.n ?? 0);
    for (const listen of membersListeners) {
      try {
        await listen({ teamId, members });
      } catch (err) {
        console.warn(`[gates] a team members listener failed: ${(err as Error).message}`);
      }
    }
  })().catch((err) => console.warn(`[gates] counting a team's members failed: ${(err as Error).message}`));
}

/** For the kit: a team's basics, or null. */
export async function teamInfo(db: Database, teamId: string) {
  const [team] = await db
    .select({ id: teams.id, name: teams.name, createdAt: teams.createdAt, createdByUserId: teams.createdByUserId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (!team) return null;
  const [row] = await db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
  return { ...team, members: Number(row?.n ?? 0) };
}

/** For the kit: someone's role in a team, or null. */
export async function teamRoleOf(db: Database, teamId: string, userId: string): Promise<'owner' | 'member' | null> {
  const [row] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return (row?.role as 'owner' | 'member' | undefined) ?? null;
}
