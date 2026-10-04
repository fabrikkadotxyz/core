/**
 * Comments on outputs: review as a conversation about a passage (M23).
 * See docs/protocol.md and docs/data-model.md.
 *
 * A thread is anchored to a quoted passage by the anchored-edit rule — it must
 * occur exactly once when the comment is made — and is "outdated" whenever that
 * stops being true. Outdated is computed from the current text, never stored,
 * and an outdated thread is shown as such, never moved to a guess.
 *
 * People comment (members, viewers, guests); agents resolve by editing. A
 * comment never delivers anything: it is not a message and wakes no agent.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { outputComments, participants, users } from '@fabrikka/db';
import type { OutputComment } from '@fabrikka/types';
import { publish } from '../bus.ts';
import { anchorState } from '../output-text.ts';
import { currentTexts, isOutputId } from './core.ts';
import { OutputError } from './errors.ts';

const MAX_BODY = 4000;
const MAX_QUOTE = 1000;

function cleanBody(body: string): string {
  const b = body.trim();
  if (!b) throw new OutputError('invalid_edit', 'a comment needs some text');
  return b.slice(0, MAX_BODY);
}

export async function listComments(
  db: Database,
  sessionId: string,
  outputId: string,
  opts: { includeResolved?: boolean } = {},
): Promise<OutputComment[]> {
  const { texts } = await currentTexts(db, sessionId, outputId);
  const rows = await db
    .select({ c: outputComments, author: users.displayName })
    .from(outputComments)
    .innerJoin(users, eq(users.id, outputComments.authorUserId))
    .where(eq(outputComments.outputId, outputId))
    .orderBy(asc(outputComments.createdAt));

  // Resolvers can be a person or an agent; look both up once.
  const userIds = [...new Set(rows.map((r) => r.c.resolvedByUserId).filter(Boolean))] as string[];
  const partIds = [...new Set(rows.map((r) => r.c.resolvedByParticipantId).filter(Boolean))] as string[];
  const userNames = new Map(
    userIds.length
      ? (await db.select({ id: users.id, n: users.displayName }).from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.n])
      : [],
  );
  const partNames = new Map(
    partIds.length
      ? (
          await db
            .select({ id: participants.id, n: participants.displayName })
            .from(participants)
            .where(inArray(participants.id, partIds))
        ).map((p) => [p.id, p.n])
      : [],
  );

  const threads = new Map<string, OutputComment>();
  for (const { c, author } of rows) {
    if (c.parentId) continue;
    const text = texts.get(c.file);
    threads.set(c.id, {
      id: c.id,
      file: c.file,
      quote: c.quote ?? '',
      body: c.body,
      author,
      createdAt: c.createdAt.toISOString(),
      status: c.status as OutputComment['status'],
      outdated: text === undefined || anchorState(text, c.quote ?? '') !== 'found',
      resolvedBy: c.resolvedByParticipantId
        ? (partNames.get(c.resolvedByParticipantId) ?? 'an agent')
        : c.resolvedByUserId
          ? (userNames.get(c.resolvedByUserId) ?? 'someone')
          : null,
      resolvedAtVersion: c.resolvedAtVersion,
      replies: [],
    });
  }
  for (const { c, author } of rows) {
    if (!c.parentId) continue;
    threads.get(c.parentId)?.replies.push({ id: c.id, body: c.body, author, createdAt: c.createdAt.toISOString() });
  }
  const all = [...threads.values()];
  return opts.includeResolved === false ? all.filter((t) => t.status === 'open') : all;
}

/** Start a thread on a passage. The passage must occur exactly once, now. */
export async function addComment(
  db: Database,
  opts: { sessionId: string; outputId: string; userId: string; file?: string; quote: string; body: string },
): Promise<string> {
  const { texts, mainFile } = await currentTexts(db, opts.sessionId, opts.outputId);
  const file = opts.file ?? mainFile;
  const text = texts.get(file);
  if (text === undefined) throw new OutputError('not_found', `no file "${file}" in this output`);
  const quote = opts.quote.slice(0, MAX_QUOTE);
  const state = anchorState(text, quote);
  if (state === 'missing') throw new OutputError('anchor_not_found', 'that passage is not in the file — select text that is there now');
  if (state === 'ambiguous') throw new OutputError('anchor_ambiguous', 'that passage occurs more than once — select a longer one');

  const [row] = await db
    .insert(outputComments)
    .values({ outputId: opts.outputId, file, quote, body: cleanBody(opts.body), authorUserId: opts.userId })
    .returning({ id: outputComments.id });
  publish(opts.sessionId, { type: 'comments.changed', outputId: opts.outputId });
  return row!.id;
}

async function thread(db: Database, outputId: string, commentId: string) {
  if (!isOutputId(commentId)) return null;
  const [row] = await db
    .select()
    .from(outputComments)
    .where(and(eq(outputComments.id, commentId), eq(outputComments.outputId, outputId), isNull(outputComments.parentId)))
    .limit(1);
  return row ?? null;
}

export async function reply(
  db: Database,
  opts: { sessionId: string; outputId: string; userId: string; commentId: string; body: string },
): Promise<string> {
  await currentTexts(db, opts.sessionId, opts.outputId); // scopes the output to the session
  const t = await thread(db, opts.outputId, opts.commentId);
  if (!t) throw new OutputError('not_found', 'no such comment on this output');
  const [row] = await db
    .insert(outputComments)
    .values({ outputId: opts.outputId, parentId: t.id, file: t.file, body: cleanBody(opts.body), authorUserId: opts.userId })
    .returning({ id: outputComments.id });
  publish(opts.sessionId, { type: 'comments.changed', outputId: opts.outputId });
  return row!.id;
}

/** A person resolves or reopens a thread. Resolved threads collapse; they never disappear. */
export async function setResolved(
  db: Database,
  opts: { sessionId: string; outputId: string; userId: string; commentId: string; resolved: boolean },
): Promise<{ authorUserId: string }> {
  await currentTexts(db, opts.sessionId, opts.outputId);
  const t = await thread(db, opts.outputId, opts.commentId);
  if (!t) throw new OutputError('not_found', 'no such comment on this output');
  await db
    .update(outputComments)
    .set(
      opts.resolved
        ? { status: 'resolved', resolvedByUserId: opts.userId, resolvedByParticipantId: null, resolvedAt: new Date() }
        : { status: 'open', resolvedByUserId: null, resolvedByParticipantId: null, resolvedAt: null, resolvedAtVersion: null },
    )
    .where(eq(outputComments.id, t.id));
  publish(opts.sessionId, { type: 'comments.changed', outputId: opts.outputId });
  return { authorUserId: t.authorUserId };
}

/** Before an edit that claims to resolve a thread: it must exist and be open. */
export async function assertResolvable(db: Database, outputId: string, commentId: string): Promise<void> {
  const t = await thread(db, outputId, commentId);
  if (!t) throw new OutputError('invalid_edit', `resolves: no comment "${commentId}" on this output`);
  if (t.status !== 'open') throw new OutputError('invalid_edit', 'resolves: that comment is already resolved');
}

/** After the edit landed: the agent resolved it, at that version. */
export async function resolveByEdit(
  db: Database,
  opts: { sessionId: string; outputId: string; commentId: string; participantId: string; version: number },
): Promise<void> {
  await db
    .update(outputComments)
    .set({
      status: 'resolved',
      resolvedByParticipantId: opts.participantId,
      resolvedByUserId: null,
      resolvedAtVersion: opts.version,
      resolvedAt: new Date(),
    })
    .where(and(eq(outputComments.id, opts.commentId), eq(outputComments.outputId, opts.outputId)));
  publish(opts.sessionId, { type: 'comments.changed', outputId: opts.outputId });
}

/** Who started a thread — scoped to the session's output, or null. */
export async function threadAuthor(
  db: Database,
  sessionId: string,
  outputId: string,
  commentId: string,
): Promise<string | null> {
  try {
    await currentTexts(db, sessionId, outputId);
  } catch {
    return null;
  }
  return (await thread(db, outputId, commentId))?.authorUserId ?? null;
}
