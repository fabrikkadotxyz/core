/**
 * Session data access.
 *
 * Every lookup is scoped by BOTH owner slug and session public id, and a
 * mismatch is indistinguishable from "does not exist". See
 * docs/decisions/0006-owner-scoped-endpoint-path.md and docs/security.md.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { messages, participants, sessions, users } from '@fabrikka/db';
import type { Message, Participant, Session } from '@fabrikka/types';

export interface ResolvedSession {
  /** Internal id. Never leaves the server. */
  id: string;
  view: Session;
}

/**
 * Resolve a session from its public path segments.
 *
 * Returns null when the session does not exist OR when `ownerSlug` is not its
 * owner. Callers must render both cases as 404 — existence is itself private.
 */
export async function resolveSession(
  db: Database,
  ownerSlug: string,
  sessionPublicId: string,
): Promise<ResolvedSession | null> {
  const rows = await db
    .select({
      id: sessions.id,
      publicId: sessions.publicId,
      title: sessions.title,
      status: sessions.status,
      createdAt: sessions.createdAt,
      ownerSlug: users.ownerSlug,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(eq(sessions.publicId, sessionPublicId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // The owner segment is validated, never trusted. It can only reject a
  // request, never admit one.
  if (row.ownerSlug !== ownerSlug) return null;

  return {
    id: row.id,
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

/** True when the participant belongs to this session. */
export async function participantInSession(
  db: Database,
  sessionId: string,
  participantId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.id, participantId),
        eq(participants.sessionId, sessionId),
      ),
    )
    .limit(1);

  return rows.length > 0;
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
