/**
 * Session data access, membership-scoped.
 *
 * Two invariants this module exists to enforce:
 *
 * 1. Every lookup is scoped by owner slug AND session public id, and a mismatch
 *    is indistinguishable from "does not exist" (ADR 0006).
 * 2. A non-member gets the same answer as someone asking about a session that
 *    isn't there. Callers render `null` as 404, never 403 — a 403 would leak the
 *    existence and id of private sessions (docs/security.md).
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  messages,
  participants,
  sessionMembers,
  sessions,
  users,
} from '@fabrikka/db';
import type { Message, Participant, Session, SessionSummary } from '@fabrikka/types';

export type SessionRole = 'owner' | 'member';

export interface ResolvedSession {
  /** Internal id. Never leaves the server. */
  id: string;
  view: Session;
  /** The requesting user's role in this session. */
  role: SessionRole;
  /** The requesting user's participant row in this session. */
  participantId: string;
}

/**
 * Resolve a session for a specific user.
 *
 * Returns null when the session does not exist, when `ownerSlug` is not its
 * owner, OR when the user is not a member. The caller cannot tell which.
 */
export async function resolveSessionForUser(
  db: Database,
  ownerSlug: string,
  sessionPublicId: string,
  userId: string,
): Promise<ResolvedSession | null> {
  const rows = await db
    .select({
      id: sessions.id,
      publicId: sessions.publicId,
      title: sessions.title,
      status: sessions.status,
      createdAt: sessions.createdAt,
      ownerSlug: users.ownerSlug,
      role: sessionMembers.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    // An inner join on membership is what makes non-members indistinguishable
    // from a missing session: no row comes back either way.
    .innerJoin(
      sessionMembers,
      and(
        eq(sessionMembers.sessionId, sessions.id),
        eq(sessionMembers.userId, userId),
      ),
    )
    .where(eq(sessions.publicId, sessionPublicId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // The owner segment is validated, never trusted: it can only reject.
  if (row.ownerSlug !== ownerSlug) return null;

  const [me] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(eq(participants.sessionId, row.id), eq(participants.userId, userId)),
    )
    .limit(1);

  if (!me) return null;

  return {
    id: row.id,
    role: row.role as SessionRole,
    participantId: me.id,
    view: {
      id: row.id,
      publicId: row.publicId,
      ownerSlug: row.ownerSlug,
      title: row.title,
      status: row.status as Session['status'],
      createdAt: row.createdAt.toISOString(),
    },
  };
}

/** Sessions this user is a member of, newest first. */
export async function listSessionsForUser(
  db: Database,
  userId: string,
): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      publicId: sessions.publicId,
      title: sessions.title,
      status: sessions.status,
      createdAt: sessions.createdAt,
      ownerSlug: users.ownerSlug,
      role: sessionMembers.role,
      memberCount: sql<number>`(
        select count(*) from ${sessionMembers} sm
        where sm.session_id = ${sessions.id}
      )`,
    })
    .from(sessionMembers)
    .innerJoin(sessions, eq(sessions.id, sessionMembers.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(eq(sessionMembers.userId, userId))
    .orderBy(desc(sessions.createdAt));

  return rows.map((r) => ({
    publicId: r.publicId,
    ownerSlug: r.ownerSlug,
    title: r.title,
    status: r.status as Session['status'],
    role: r.role as SessionRole,
    memberCount: Number(r.memberCount),
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Create a session. The creator becomes its owner member and gets a participant
 * row, so a session is never in a state where it exists but has nobody in it.
 */
export async function createSession(
  db: Database,
  owner: { id: string; displayName: string; ownerSlug: string },
  title: string,
): Promise<SessionSummary> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(sessions)
      .values({ publicId: await freePublicId(tx, title), ownerId: owner.id, title })
      .returning();

    await tx.insert(sessionMembers).values({
      sessionId: session!.id,
      userId: owner.id,
      role: 'owner',
    });

    await tx.insert(participants).values({
      sessionId: session!.id,
      kind: 'human',
      userId: owner.id,
      displayName: owner.displayName,
    });

    return {
      publicId: session!.publicId,
      ownerSlug: owner.ownerSlug,
      title: session!.title,
      status: session!.status as Session['status'],
      role: 'owner' as SessionRole,
      memberCount: 1,
      createdAt: session!.createdAt.toISOString(),
    };
  });
}

export async function renameSession(
  db: Database,
  sessionId: string,
  title: string,
): Promise<void> {
  await db.update(sessions).set({ title }).where(eq(sessions.id, sessionId));
}

export async function setSessionStatus(
  db: Database,
  sessionId: string,
  status: 'active' | 'archived',
): Promise<void> {
  await db.update(sessions).set({ status }).where(eq(sessions.id, sessionId));
}

export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/* -------------------------------------------------------------------------- */
/* Membership                                                                 */
/* -------------------------------------------------------------------------- */

export interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: SessionRole;
}

export async function listMembers(
  db: Database,
  sessionId: string,
): Promise<Member[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: sessionMembers.role,
    })
    .from(sessionMembers)
    .innerJoin(users, eq(users.id, sessionMembers.userId))
    .where(eq(sessionMembers.sessionId, sessionId))
    .orderBy(asc(users.displayName));

  return rows.map((r) => ({ ...r, role: r.role as SessionRole }));
}

/**
 * Add a user to a session, with a participant row.
 *
 * Idempotent: re-adding an existing member is a no-op rather than an error, so
 * a double-submitted invite redemption can't 500.
 */
export async function addMember(
  db: Database,
  sessionId: string,
  user: { id: string; displayName: string },
  role: SessionRole,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(sessionMembers)
      .values({ sessionId, userId: user.id, role })
      .onConflictDoNothing();

    const existing = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(
        and(
          eq(participants.sessionId, sessionId),
          eq(participants.userId, user.id),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await tx.insert(participants).values({
        sessionId,
        kind: 'human',
        userId: user.id,
        displayName: await freeDisplayName(tx, sessionId, user.displayName),
      });
    }
  });
}

export async function removeMember(
  db: Database,
  sessionId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(sessionMembers)
    .where(
      and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)),
    );
}

/** How many owners a session has — used to refuse removing the last one. */
export async function countOwners(db: Database, sessionId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(sessionMembers)
    .where(
      and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.role, 'owner')),
    );
  return Number(rows[0]?.n ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Participants and messages                                                  */
/* -------------------------------------------------------------------------- */

export async function listParticipants(
  db: Database,
  sessionId: string,
): Promise<Participant[]> {
  const rows = await db
    .select()
    .from(participants)
    .where(eq(participants.sessionId, sessionId))
    .orderBy(asc(participants.displayName));

  return rows.map((p) => ({
    id: p.id,
    sessionId: p.sessionId,
    kind: p.kind as Participant['kind'],
    displayName: p.displayName,
  }));
}

export async function listMessages(
  db: Database,
  sessionId: string,
  limit = 100,
): Promise<Message[]> {
  const rows = await db
    .select({
      id: messages.id,
      sessionId: messages.sessionId,
      content: messages.content,
      createdAt: messages.createdAt,
      authorId: participants.id,
      authorKind: participants.kind,
      authorName: participants.displayName,
    })
    .from(messages)
    .innerJoin(participants, eq(participants.id, messages.authorParticipantId))
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
    .limit(limit);

  return rows.map(toMessage);
}

export async function createMessage(
  db: Database,
  sessionId: string,
  authorParticipantId: string,
  content: string,
): Promise<Message> {
  const [inserted] = await db
    .insert(messages)
    .values({ sessionId, authorParticipantId, content })
    .returning();

  const [author] = await db
    .select()
    .from(participants)
    .where(eq(participants.id, authorParticipantId))
    .limit(1);

  return toMessage({
    id: inserted!.id,
    sessionId: inserted!.sessionId,
    content: inserted!.content,
    createdAt: inserted!.createdAt,
    authorId: author!.id,
    authorKind: author!.kind,
    authorName: author!.displayName,
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Slugify a title into a public id, suffixing on collision. */
async function freePublicId(tx: Tx, title: string): Promise<string> {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session';

  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.publicId, candidate))
      .limit(1);
    if (taken.length === 0) return candidate;
  }
}

/** participants is unique on (session_id, display_name), so de-duplicate. */
async function freeDisplayName(
  tx: Tx,
  sessionId: string,
  desired: string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? desired : `${desired}-${attempt + 1}`;
    const taken = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(
        and(
          eq(participants.sessionId, sessionId),
          eq(participants.displayName, candidate),
        ),
      )
      .limit(1);
    if (taken.length === 0) return candidate;
  }
}

interface MessageRow {
  id: string;
  sessionId: string;
  content: string;
  createdAt: Date;
  authorId: string;
  authorKind: string;
  authorName: string;
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    sessionId: r.sessionId,
    author: {
      participantId: r.authorId,
      kind: r.authorKind as Participant['kind'],
      displayName: r.authorName,
    },
    content: r.content,
    // Mentions become real rows at M2 (docs/data-model.md).
    mentions: [],
    createdAt: r.createdAt.toISOString(),
  };
}
