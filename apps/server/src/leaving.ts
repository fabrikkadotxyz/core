/**
 * Leaving (M58, ADR 0057): an account is deactivated, then deleted; what it
 * wrote stays.
 *
 * Deactivated: cannot sign in, every login session gone, nothing else changes.
 * Deletion requested: deactivated, and `runDueDeletions` deletes after the
 * grace period unless a sign-in cancels it first (auth.ts).
 * Deleted: the `users` row is a tombstone. Personal data is gone; every
 * participant row and what hangs off it stays, under the person's name or,
 * if they chose so, under FORMER_MEMBER.
 *
 * The application never deletes a `users` row. The CLI, the API and the kit
 * all come through here, so they cannot disagree (docs/operations.md,
 * docs/protocol.md, docs/security.md "Leaving").
 */
import { and, asc, eq, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  agents,
  authSessions,
  devicePairings,
  devices,
  grantDefaults,
  mcpServers,
  oauthFlows,
  participants,
  passwordResets,
  sessionGuests,
  sessionInvites,
  sessionMembers,
  sessionReads,
  sessionTemplates,
  sessionTokens,
  sessions,
  teamMembers,
  teams,
  users,
  verifyPassword,
} from '@fabrikka/db';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The name content keeps when the person asked for theirs to go. A handle, so mention matching stays whole (sessions.ts). */
export const FORMER_MEMBER = 'former-member';

/** Days between the request and the deletion. A sign-in meanwhile cancels. */
export const GRACE_DAYS = (() => {
  const n = Number(process.env.FABRIKKA_DELETION_GRACE_DAYS ?? 14);
  return Number.isInteger(n) && n >= 0 ? n : 14;
})();

export type AccountState = 'active' | 'deactivated' | 'deleted';

export function accountStateOf(row: { deactivatedAt: Date | null; deletedAt: Date | null }): AccountState {
  if (row.deletedAt) return 'deleted';
  if (row.deactivatedAt) return 'deactivated';
  return 'active';
}

/** For a list row: the mark the UI shows, or nothing for an active account. */
export function accountMark(row: { deactivatedAt: Date | null; deletedAt: Date | null }): 'deactivated' | 'deleted' | undefined {
  const s = accountStateOf(row);
  return s === 'active' ? undefined : s;
}

async function stateOf(db: Database | Tx, userId: string): Promise<AccountState | null> {
  const [row] = await db
    .select({ deactivatedAt: users.deactivatedAt, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? accountStateOf(row) : null;
}

/** True for an account that may act: signed in, through a device, or through an agent it owns. */
export async function isActiveUser(db: Database, userId: string): Promise<boolean> {
  return (await stateOf(db, userId)) === 'active';
}

/* -------------------------------------------------------------- deactivate */

export async function deactivateUser(db: Database, userId: string): Promise<boolean> {
  const state = await stateOf(db, userId);
  if (state === null || state === 'deleted') return false;
  await db.transaction(async (tx) => {
    if (state === 'active') await tx.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, userId));
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));
  });
  return true;
}

/** Undo a deactivation, or cancel a deletion that has not happened yet. */
export async function reactivateUser(db: Database, userId: string): Promise<boolean> {
  const state = await stateOf(db, userId);
  if (state === null || state === 'deleted') return false;
  await db.update(users).set({ deactivatedAt: null, deletionRequestedAt: null }).where(eq(users.id, userId));
  return true;
}

/* ----------------------------------------------------------------- request */

export type RequestResult = { ok: true; effectiveAt: Date } | { ok: false; error: string; status: 400 | 401 | 404 };

/** Settings → Account: the person asks, with their password, and chooses what name stays. */
export async function requestDeletion(
  db: Database,
  userId: string,
  input: { password: string; eraseName: boolean },
): Promise<RequestResult> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || row.deletedAt) return { ok: false, error: 'no such account', status: 404 };
  if (!(await verifyPassword(input.password, row.passwordHash))) {
    return { ok: false, error: 'wrong password', status: 401 };
  }
  return scheduleDeletion(db, userId, input);
}

/** The operator or a deployment asks on the person's behalf: no password, same grace. */
export async function scheduleDeletion(
  db: Database,
  userId: string,
  input: { eraseName: boolean },
): Promise<RequestResult> {
  const state = await stateOf(db, userId);
  if (state === null || state === 'deleted') return { ok: false, error: 'no such account', status: 404 };
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ deletionRequestedAt: now, deactivatedAt: now, eraseName: input.eraseName })
      .where(eq(users.id, userId));
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));
  });
  return { ok: true, effectiveAt: new Date(now.getTime() + GRACE_DAYS * 86_400_000) };
}

/* ------------------------------------------------------------------ delete */

export interface DeletionPlan {
  /** Sessions with no other human member: deleted with their content. */
  soloSessions: { id: string; title: string }[];
  /** Sessions they owned that others are in: who owns them next. */
  passedSessions: { id: string; title: string; toUserId: string; toName: string }[];
  /** Teams they were the only owner of: who owns them next. */
  passedTeams: { id: string; name: string; toUserId: string; toName: string }[];
  /** Teams nobody else is on and no session of which keeps another human: deleted. */
  deletedTeams: { id: string; name: string }[];
  /** Teams nobody else is on, kept without an owner because a session in them still has another human. */
  ownerlessTeams: { id: string; name: string }[];
  /** Every team they were on, for the deployment's listener. */
  teamIds: string[];
}

export interface DeletionReport extends DeletionPlan {
  userId: string;
  eraseName: boolean;
  participantsRenamed: number;
}

/** Say what deletion would do, without doing it. The CLI prints this before `--now`. */
export async function previewDeletion(db: Database, userId: string): Promise<DeletionPlan | null> {
  const state = await stateOf(db, userId);
  if (state === null || state === 'deleted') return null;
  return plan(db, userId);
}

async function plan(db: Database | Tx, userId: string): Promise<DeletionPlan> {
  const out: DeletionPlan = { soloSessions: [], passedSessions: [], passedTeams: [], deletedTeams: [], ownerlessTeams: [], teamIds: [] };

  // Every session they are in or own.
  const mine = await db
    .select({ id: sessions.id, title: sessions.title, ownerId: sessions.ownerId, teamId: sessions.teamId })
    .from(sessions)
    .leftJoin(sessionMembers, and(eq(sessionMembers.sessionId, sessions.id), eq(sessionMembers.userId, userId)))
    .where(sql`${sessions.ownerId} = ${userId} or ${sessionMembers.userId} is not null`);
  const soloIds = new Set<string>();
  for (const s of mine) {
    const others = await db
      .select({ userId: sessionMembers.userId, role: sessionMembers.role, name: users.displayName, since: sessionMembers.createdAt })
      .from(sessionMembers)
      .innerJoin(users, eq(users.id, sessionMembers.userId))
      .where(and(eq(sessionMembers.sessionId, s.id), ne(sessionMembers.userId, userId), isNull(users.deletedAt)))
      .orderBy(asc(sessionMembers.createdAt));
    if (others.length === 0) {
      out.soloSessions.push({ id: s.id, title: s.title });
      soloIds.add(s.id);
    } else if (s.ownerId === userId) {
      const next = others.find((o) => o.role === 'owner') ?? others[0]!;
      out.passedSessions.push({ id: s.id, title: s.title, toUserId: next.userId, toName: next.name });
    }
  }

  // Every team they are on, their own organization included.
  const memberships = await db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId));
  for (const t of memberships) {
    out.teamIds.push(t.id);
    const others = await db
      .select({ userId: teamMembers.userId, role: teamMembers.role, name: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, t.id), ne(teamMembers.userId, userId), isNull(users.deletedAt)))
      .orderBy(asc(teamMembers.createdAt));
    if (others.length > 0) {
      if (t.role === 'owner' && !others.some((o) => o.role === 'owner')) {
        out.passedTeams.push({ id: t.id, name: t.name, toUserId: others[0]!.userId, toName: others[0]!.name });
      }
      continue;
    }
    // Nobody else on the team. Does any of its rooms keep another human?
    const kept = (
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(sessionMembers, eq(sessionMembers.sessionId, sessions.id))
        .where(and(eq(sessions.teamId, t.id), ne(sessionMembers.userId, userId)))
    ).filter((r) => !soloIds.has(r.id));
    if (kept.length > 0) out.ownerlessTeams.push({ id: t.id, name: t.name });
    else out.deletedTeams.push({ id: t.id, name: t.name });
  }
  return out;
}

type DeletedListener = (ctx: { userId: string; teamIds: string[] }) => void | Promise<void>;
const deletedListeners: DeletedListener[] = [];

/** After a deletion has committed. Never before. */
export function onUserDeleted(listener: DeletedListener): void {
  deletedListeners.push(listener);
}

/** Delete now. Idempotent on an already deleted account (returns null). */
export async function deleteUserNow(db: Database, userId: string): Promise<DeletionReport | null> {
  const [row] = await db
    .select({ id: users.id, deletedAt: users.deletedAt, eraseName: users.eraseName, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || row.deletedAt) return null;
  const eraseName = row.eraseName;

  const report = await db.transaction(async (tx) => {
    const p = await plan(tx, userId);
    const now = new Date();

    // Rooms nobody else is in go with them (ADR 0057 §5).
    if (p.soloSessions.length) {
      await tx.delete(sessions).where(inArray(sessions.id, p.soloSessions.map((s) => s.id)));
    }
    // Ownership passes (§6).
    for (const s of p.passedSessions) {
      await tx.update(sessions).set({ ownerId: s.toUserId }).where(eq(sessions.id, s.id));
      await tx
        .update(sessionMembers)
        .set({ role: 'owner' })
        .where(and(eq(sessionMembers.sessionId, s.id), eq(sessionMembers.userId, s.toUserId)));
    }
    for (const t of p.passedTeams) {
      await tx.update(teamMembers).set({ role: 'owner' }).where(and(eq(teamMembers.teamId, t.id), eq(teamMembers.userId, t.toUserId)));
    }
    if (p.deletedTeams.length) {
      await tx.delete(teams).where(inArray(teams.id, p.deletedTeams.map((t) => t.id)));
    }

    // Personal data (§3).
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
    await tx.delete(oauthFlows).where(eq(oauthFlows.userId, userId));
    await tx.delete(mcpServers).where(and(eq(mcpServers.ownerId, userId), isNull(mcpServers.teamId)));
    await tx.delete(grantDefaults).where(eq(grantDefaults.userId, userId));
    await tx.delete(devicePairings).where(eq(devicePairings.confirmedByUserId, userId));
    await tx.delete(devices).where(eq(devices.userId, userId));
    // Personal templates go; an organization's stay (their owner column points at the tombstone).
    await tx.delete(sessionTemplates).where(and(eq(sessionTemplates.ownerUserId, userId), isNull(sessionTemplates.teamId)));
    await tx.delete(agents).where(eq(agents.ownerId, userId));
    await tx.update(sessionTokens).set({ revokedAt: now }).where(and(eq(sessionTokens.createdByUserId, userId), isNull(sessionTokens.revokedAt)));
    await tx.update(sessionInvites).set({ revokedAt: now }).where(and(eq(sessionInvites.createdByUserId, userId), isNull(sessionInvites.revokedAt)));
    await tx.delete(sessionReads).where(eq(sessionReads.userId, userId));
    await tx.delete(sessionGuests).where(eq(sessionGuests.userId, userId));
    await tx.delete(sessionMembers).where(eq(sessionMembers.userId, userId));
    await tx.delete(teamMembers).where(eq(teamMembers.userId, userId));

    // The name on what they wrote (§4).
    let participantsRenamed = 0;
    if (eraseName) {
      const mineP = await tx
        .select({ id: participants.id, sessionId: participants.sessionId })
        .from(participants)
        .where(and(eq(participants.userId, userId), eq(participants.kind, 'human')));
      for (const part of mineP) {
        await tx.update(participants).set({ displayName: await freeFormerName(tx, part.sessionId) }).where(eq(participants.id, part.id));
        participantsRenamed++;
      }
    }

    // The tombstone (§4): nothing personal, the row kept for what it wrote.
    await tx
      .update(users)
      .set({
        email: `deleted-${userId}@deleted.invalid`,
        passwordHash: null,
        emailVerifiedAt: null,
        theme: null,
        preferredAgents: null,
        wantedAgents: null,
        isInstanceOwner: false,
        displayName: eraseName ? FORMER_MEMBER : row.displayName,
        ownerSlug: eraseName ? `${FORMER_MEMBER}-${userId.slice(0, 8)}` : undefined,
        deactivatedAt: now,
        deletedAt: now,
      })
      .where(eq(users.id, userId));

    return { ...p, userId, eraseName, participantsRenamed } satisfies DeletionReport;
  });

  for (const listener of deletedListeners) {
    try {
      await listener({ userId, teamIds: report.teamIds });
    } catch (err) {
      console.warn(`[leaving] a listener failed after deleting ${userId}: ${(err as Error).message}`);
    }
  }
  return report;
}

async function freeFormerName(tx: Tx, sessionId: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? FORMER_MEMBER : `${FORMER_MEMBER}-${attempt + 1}`;
    const taken = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.sessionId, sessionId), eq(participants.displayName, candidate)))
      .limit(1);
    if (taken.length === 0) return candidate;
  }
}

/** The daily job: delete what was requested more than GRACE_DAYS ago. Returns how many. */
export async function runDueDeletions(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - GRACE_DAYS * 86_400_000);
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.deletedAt), lt(users.deletionRequestedAt, cutoff)));
  let n = 0;
  for (const u of due) {
    if (await deleteUserNow(db, u.id)) n++;
  }
  return n;
}

/** For the CLI: an account by address, deleted ones included. */
export async function findUserForLeaving(db: Database, email: string) {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      deactivatedAt: users.deactivatedAt,
      deletionRequestedAt: users.deletionRequestedAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ?? null;
}

/** Keeps the import list honest when a table is only used by name in SQL. */
export const _tables = { notInArray };
