/**
 * Since you were away (M24): where you left off, and what's waiting for you.
 * See docs/data-model.md.
 *
 * Built from the record, never generated: Fabrikka has no model. Notes (M65)
 * carry a sequence number and a removal time, so catch-up lists the ones added
 * after the last one you had seen, and the ones removed since your visit;
 * messages, edits and link statuses compare by time.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '@fabrikka/db';
import {
  messageMentions,
  messages,
  outputEdits,
  outputs,
  participants,
  sessionLinks,
  sessionNotes,
  sessionReads,
  sessions,
  users,
} from '@fabrikka/db';
import type { CatchUp, WaitingItem } from '@fabrikka/types';
import { renderMentions } from './mentions.ts';
import { latestNoteSeq } from './sessions.ts';

export async function getCatchUp(db: Database, sessionId: string, userId: string): Promise<CatchUp> {
  const [read] = await db
    .select()
    .from(sessionReads)
    .where(and(eq(sessionReads.sessionId, sessionId), eq(sessionReads.userId, userId)))
    .limit(1);
  if (!read) return { firstVisit: true, since: null };
  const since = read.lastSeenAt;

  const people = await db
    .select({ id: participants.id, displayName: participants.displayName, userId: participants.userId })
    .from(participants)
    .where(eq(participants.sessionId, sessionId));
  const mine = people.find((p) => p.userId === userId)?.id ?? null;

  const by = alias(participants, 'by');
  const newNotes = await db
    .select({ text: sessionNotes.text, tag: sessionNotes.tag, by: by.displayName })
    .from(sessionNotes)
    .leftJoin(by, eq(by.id, sessionNotes.participantId))
    .where(and(eq(sessionNotes.sessionId, sessionId), gt(sessionNotes.seq, Number(read.notesSeenSeq)), isNull(sessionNotes.removedAt)))
    .orderBy(sessionNotes.seq);
  const gone = await db
    .select({ text: sessionNotes.text, tag: sessionNotes.tag, by: by.displayName })
    .from(sessionNotes)
    .leftJoin(by, eq(by.id, sessionNotes.participantId))
    .where(and(eq(sessionNotes.sessionId, sessionId), isNotNull(sessionNotes.removedAt), gt(sessionNotes.removedAt, since)))
    .orderBy(sessionNotes.seq);

  const newMessages = await db
    .select({ id: messages.id, content: messages.content, at: messages.createdAt, author: participants.displayName })
    .from(messages)
    .innerJoin(participants, eq(participants.id, messages.authorParticipantId))
    .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, since)))
    .orderBy(desc(messages.createdAt));
  const mentionedIds = mine && newMessages.length
    ? new Set(
        (
          await db
            .select({ id: messageMentions.messageId })
            .from(messageMentions)
            .where(and(eq(messageMentions.participantId, mine), inArray(messageMentions.messageId, newMessages.map((m) => m.id))))
        ).map((r) => r.id),
      )
    : new Set<string>();

  const edits = await db
    .select({
      outputName: outputs.name,
      editor: sql<string>`coalesce(${participants.displayName}, ${outputEdits.externalAuthor}, 'someone')`,
      n: sql<number>`count(*)`,
    })
    .from(outputEdits)
    .innerJoin(outputs, eq(outputs.id, outputEdits.outputId))
    .leftJoin(participants, eq(participants.id, outputEdits.participantId))
    .where(and(eq(outputs.sessionId, sessionId), gt(outputEdits.createdAt, since)))
    .groupBy(outputs.name, participants.displayName, outputEdits.externalAuthor);
  const byOutput = new Map<string, { name: string; editors: string[]; edits: number; isNew?: boolean }>();
  for (const e of edits) {
    const o = byOutput.get(e.outputName) ?? { name: e.outputName, editors: [], edits: 0 };
    o.editors.push(e.editor);
    o.edits += Number(e.n);
    byOutput.set(e.outputName, o);
  }
  // A document created while you were away is news even before anyone edits it.
  const created = await db
    .select({ name: outputs.name, by: participants.displayName })
    .from(outputs)
    .innerJoin(participants, eq(participants.id, outputs.createdByParticipantId))
    .where(and(eq(outputs.sessionId, sessionId), gt(outputs.createdAt, since)));
  for (const o of created) {
    const entry = byOutput.get(o.name) ?? { name: o.name, editors: [], edits: 0 };
    if (!entry.editors.includes(o.by)) entry.editors.unshift(o.by);
    byOutput.set(o.name, { ...entry, isNew: true } as typeof entry);
  }

  const moved = await db
    .select({ title: sessionLinks.title, url: sessionLinks.url, status: sessionLinks.status })
    .from(sessionLinks)
    .where(and(eq(sessionLinks.sessionId, sessionId), isNotNull(sessionLinks.statusAt), gt(sessionLinks.statusAt, since)));

  return {
    firstVisit: false,
    since: since.toISOString(),
    notes: newNotes,
    removedNotes: gone,
    messages: newMessages.length,
    mentions: newMessages
      .filter((m) => mentionedIds.has(m.id))
      .map((m) => ({ from: m.author, text: renderMentions(m.content, people).slice(0, 280), at: m.at.toISOString() })),
    outputs: [...byOutput.values()],
    links: moved.map((l) => ({ title: l.title ?? l.url, url: l.url, status: l.status! })),
  };
}

/** You've caught up: remember now, and the newest note you have seen. */
export async function markSeen(db: Database, sessionId: string, userId: string): Promise<void> {
  const notesSeenSeq = await latestNoteSeq(db, sessionId);
  const now = new Date();
  await db
    .insert(sessionReads)
    .values({ sessionId, userId, lastSeenAt: now, notesSeenSeq })
    .onConflictDoUpdate({ target: [sessionReads.sessionId, sessionReads.userId], set: { lastSeenAt: now, notesSeenSeq } });
}

/**
 * Waiting for you, across your sessions: messages that mention you, posted since
 * you last opened that session. It is the only cross-session view, and holds
 * nothing a session doesn't. An agent's handoff is just such a mention.
 */
export async function waitingFor(db: Database, userId: string): Promise<WaitingItem[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      title: sessions.title,
      publicId: sessions.publicId,
      ownerSlug: users.ownerSlug,
      messageId: messages.id,
      content: messages.content,
      at: messages.createdAt,
      authorId: messages.authorParticipantId,
      lastSeen: sessionReads.lastSeenAt,
    })
    .from(participants)
    .innerJoin(messageMentions, eq(messageMentions.participantId, participants.id))
    .innerJoin(messages, eq(messages.id, messageMentions.messageId))
    .innerJoin(sessions, eq(sessions.id, participants.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(sessionReads, and(eq(sessionReads.sessionId, sessions.id), eq(sessionReads.userId, userId)))
    .where(
      and(
        eq(participants.userId, userId),
        sql`(${sessionReads.lastSeenAt} is null or ${messages.createdAt} > ${sessionReads.lastSeenAt})`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  const people = sessionIds.length
    ? await db
        .select({ id: participants.id, displayName: participants.displayName, sessionId: participants.sessionId })
        .from(participants)
        .where(inArray(participants.sessionId, sessionIds))
    : [];
  const name = new Map(people.map((p) => [p.id, p.displayName]));
  return rows.map((r) => ({
    session: { ownerSlug: r.ownerSlug, publicId: r.publicId, title: r.title },
    from: name.get(r.authorId) ?? 'someone',
    text: renderMentions(r.content, people.filter((p) => p.sessionId === r.sessionId)).slice(0, 280),
    at: r.at.toISOString(),
  }));
}
