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
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '@fabrikka/db';
import {
  messageMentions,
  messages,
  participants,
  sessionNotes,
  sessionGuests,
  sessionMembers,
  sessionReads,
  sessions,
  teamMembers,
  teams,
  users,
} from '@fabrikka/db';
import { accountMark } from './leaving.ts';
import { avatarUrl } from './avatars.ts';
import type {
  Mention,
  Message,
  Participant,
  Session,
  SessionNote,
  SessionVisibility,
  SessionKind,
  SessionSummary,
  NotifySetting,
} from '@fabrikka/types';
import { resolveMentions } from './mentions.ts';

export type SessionRole = 'owner' | 'member';

/**
 * A session as seen by someone who may only be a viewer (M22). Used ONLY by the
 * explicit allowlist of read routes; every other route keeps the member-only
 * resolver, so a route nobody converted fails closed (docs/security.md, Threat 8).
 */
export interface ViewableSession {
  id: string;
  view: Session;
  access: 'member' | 'viewer';
  role: SessionRole | 'viewer';
  /** Null for a viewer: no participant, no identity to act with. */
  participantId: string | null;
}

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
      kind: sessions.kind,
      teamId: sessions.teamId,
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
      kind: row.kind as SessionKind,
      teamId: row.teamId,
    },
  };
}

/** Sessions this user is a member of, newest first. */
export async function resolveSessionForViewer(
  db: Database,
  ownerSlug: string,
  sessionPublicId: string,
  userId: string,
): Promise<ViewableSession | null> {
  const member = await resolveSessionForUser(db, ownerSlug, sessionPublicId, userId);
  if (member) return { ...member, access: 'member' };

  const [row] = await db
    .select({
      id: sessions.id,
      publicId: sessions.publicId,
      title: sessions.title,
      status: sessions.status,
      createdAt: sessions.createdAt,
      ownerSlug: users.ownerSlug,
      teamId: sessions.teamId,
      visibility: sessions.visibility,
      kind: sessions.kind,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(eq(sessions.publicId, sessionPublicId))
    .limit(1);
  if (!row || row.ownerSlug !== ownerSlug) return null;

  const guest = await db
    .select({ userId: sessionGuests.userId })
    .from(sessionGuests)
    .where(and(eq(sessionGuests.sessionId, row.id), eq(sessionGuests.userId, userId)))
    .limit(1);
  let viewer = guest.length > 0;
  if (!viewer && row.visibility === 'team' && row.teamId) {
    const onTeam = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, row.teamId), eq(teamMembers.userId, userId)))
      .limit(1);
    viewer = onTeam.length > 0;
  }
  if (!viewer) return null;

  return {
    id: row.id,
    access: 'viewer',
    role: 'viewer',
    participantId: null,
    view: {
      id: row.id,
      publicId: row.publicId,
      ownerSlug: row.ownerSlug,
      title: row.title,
      status: row.status as Session['status'],
      createdAt: row.createdAt.toISOString(),
      kind: row.kind as SessionKind,
      teamId: row.teamId,
    },
  };
}

/**
 * M42 (ADR 0037): the room's setting for this person, with the kind's default.
 * Raw SQL over the outer query's `sessions` row, so it composes into the list.
 */
const notifyFor = (userId: string) => sql<NotifySetting>`coalesce(
  (select sr.notify from session_reads sr where sr.session_id = ${sessions.id} and sr.user_id = ${userId}),
  case when ${sessions.kind} = 'direct' then 'everything' else 'needs_you' end)`;
const seenFor = (userId: string) =>
  sql`coalesce((select sr.last_seen_at from session_reads sr where sr.session_id = ${sessions.id} and sr.user_id = ${userId}), 'epoch'::timestamptz)`;

/**
 * M42: what needs this person in this room, since they last looked. Derived,
 * never stored: mentions of them (or, with "everything", any message from
 * someone else), their agents' runs that ended, and a pause they can resume.
 */
const needsYouFor = (userId: string) => sql<number>`case when ${notifyFor(userId)} = 'nothing' then 0 else (
  (select count(*) from ${messages} m join ${participants} a on a.id = m.author_participant_id
    where m.session_id = ${sessions.id} and m.created_at > ${seenFor(userId)}
      and (a.user_id is null or a.user_id <> ${userId})
      and (${notifyFor(userId)} = 'everything' or exists (
        select 1 from ${messageMentions} mm join ${participants} p on p.id = mm.participant_id
        where mm.message_id = m.id and p.user_id = ${userId})))
  + (select count(*) from runs r join ${participants} p on p.id = r.participant_id
      join session_agents sa on sa.id = p.session_agent_id join agents ag on ag.id = sa.agent_id
    where r.session_id = ${sessions.id} and ag.owner_id = ${userId}
      and r.status in ('done', 'failed', 'stopped') and r.ended_at > ${seenFor(userId)})
  + (case when ${sessions.agentsPausedAt} > ${seenFor(userId)} then 1 else 0 end)
) end`;

export async function listSessionsForUser(
  db: Database,
  userId: string,
  /** M42: just this session, when the per-person stream recomputes one room. */
  onlySessionId?: string,
): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      publicId: sessions.publicId,
      title: sessions.title,
      status: sessions.status,
      createdAt: sessions.createdAt,
      ownerSlug: users.ownerSlug,
      role: sessionMembers.role,
      teamId: teams.id,
      teamName: teams.name,
      memberCount: sql<number>`(
        select count(*) from ${sessionMembers} sm
        where sm.session_id = ${sessions.id}
      )`,
      // M53 (ADR 0051): individual = private, one member, no guest.
      individual: sql<boolean>`${sessions.visibility} = 'private'
        and (select count(*) from ${sessionMembers} sm where sm.session_id = ${sessions.id}) = 1
        and not exists (select 1 from ${sessionGuests} g where g.session_id = ${sessions.id})`,
      lastActivityAt: sql<Date>`coalesce((select max(m.created_at) from ${messages} m where m.session_id = ${sessions.id}), ${sessions.createdAt})`,
      kind: sessions.kind,
      peer: sql<string | null>`(select p.display_name from ${participants} p where p.session_id = ${sessions.id} and p.kind = 'human' and p.user_id <> ${userId} limit 1)`,
      unread: sql<boolean>`${notifyFor(userId)} <> 'nothing' and exists (select 1 from ${messages} m join ${participants} a on a.id = m.author_participant_id where m.session_id = ${sessions.id} and (a.user_id is null or a.user_id <> ${userId}) and m.created_at > ${seenFor(userId)})`,
      needsYou: needsYouFor(userId),
      notify: notifyFor(userId),
    })
    .from(sessionMembers)
    .innerJoin(sessions, eq(sessions.id, sessionMembers.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(teams, eq(teams.id, sessions.teamId))
    .where(onlySessionId ? and(eq(sessionMembers.userId, userId), eq(sessions.id, onlySessionId)) : eq(sessionMembers.userId, userId))
    .orderBy(desc(sessions.createdAt));

  const mine: SessionSummary[] = rows.map((r) => ({
    publicId: r.publicId,
    ownerSlug: r.ownerSlug,
    title: r.title,
    status: r.status as Session['status'],
    role: r.role as SessionRole,
    memberCount: Number(r.memberCount),
    team: r.teamId ? { id: r.teamId, name: r.teamName! } : null,
    individual: (r.kind ?? 'session') === 'session' && !!r.individual,
    createdAt: r.createdAt.toISOString(),
    lastActivityAt: new Date(r.lastActivityAt).toISOString(),
    kind: r.kind as SessionKind,
    peer: r.peer,
    unread: !!r.unread,
    needsYou: Number(r.needsYou),
    notify: r.notify,
  }));

  // M22: sessions you can read without being in them — as a guest, or because
  // they're team-visible to a team you're on. Never one you're already in.
  const memberOf = db.select({ id: sessionMembers.sessionId }).from(sessionMembers).where(eq(sessionMembers.userId, userId));
  const guestOf = db.select({ id: sessionGuests.sessionId }).from(sessionGuests).where(eq(sessionGuests.userId, userId));
  const myTeams = db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId));
  const viewable = await db
    .select({
      publicId: sessions.publicId,
      title: sessions.title,
      status: sessions.status,
      createdAt: sessions.createdAt,
      ownerSlug: users.ownerSlug,
      teamId: teams.id,
      teamName: teams.name,
      memberCount: sql<number>`(select count(*) from ${sessionMembers} sm where sm.session_id = ${sessions.id})`,
      lastActivityAt: sql<Date>`coalesce((select max(m.created_at) from ${messages} m where m.session_id = ${sessions.id}), ${sessions.createdAt})`,
      kind: sessions.kind,
      peer: sql<string | null>`(select p.display_name from ${participants} p where p.session_id = ${sessions.id} and p.kind = 'human' and p.user_id <> ${userId} limit 1)`,
      unread: sql<boolean>`exists (select 1 from ${messages} m join ${participants} a on a.id = m.author_participant_id where m.session_id = ${sessions.id} and (a.user_id is null or a.user_id <> ${userId}) and m.created_at > coalesce((select sr.last_seen_at from session_reads sr where sr.session_id = ${sessions.id} and sr.user_id = ${userId}), 'epoch'::timestamptz))`,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(teams, eq(teams.id, sessions.teamId))
    .where(
      and(
        notInArray(sessions.id, memberOf),
        or(inArray(sessions.id, guestOf), and(eq(sessions.visibility, 'team'), inArray(sessions.teamId, myTeams))),
        onlySessionId ? eq(sessions.id, onlySessionId) : undefined,
      ),
    );

  return [
    ...mine,
    ...viewable.map((r) => ({
      publicId: r.publicId,
      ownerSlug: r.ownerSlug,
      title: r.title,
      status: r.status as Session['status'],
      role: 'viewer' as const,
      memberCount: Number(r.memberCount),
      team: r.teamId ? { id: r.teamId, name: r.teamName! } : null,
      // A viewer is never alone in it: a session you only read is an organization session.
      individual: false,
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: new Date(r.lastActivityAt).toISOString(),
      kind: r.kind as SessionKind,
      peer: r.peer,
      unread: !!r.unread,
      // Viewers aren't participants: nothing in the room is addressed to them.
      needsYou: 0,
    })),
    // Most recently active first (M28): the latest message, or creation.
  ].sort((a, b) => (a.lastActivityAt! < b.lastActivityAt! ? 1 : -1));
}

/**
 * Create a session. The creator becomes its owner member and gets a participant
 * row, so a session is never in a state where it exists but has nobody in it.
 */
export async function createSession(
  db: Database,
  owner: { id: string; displayName: string; ownerSlug: string },
  title: string,
  opts: { teamId?: string | null; kind?: SessionKind; directKey?: string; visibility?: 'private' | 'team' } = {},
): Promise<SessionSummary> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(sessions)
      .values({
        publicId: await freePublicId(tx, title),
        ownerId: owner.id,
        title,
        teamId: opts.teamId ?? null,
        visibility: opts.visibility ?? 'private',
        kind: opts.kind ?? 'session',
        directKey: opts.directKey ?? null,
      })
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

    // M53 (ADR 0051): the answer says where it landed, and that it is individual while only you are in it.
    const [team] = session!.teamId ? await tx.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, session!.teamId)).limit(1) : [];
    return {
      publicId: session!.publicId,
      ownerSlug: owner.ownerSlug,
      title: session!.title,
      status: session!.status as Session['status'],
      role: 'owner' as SessionRole,
      memberCount: 1,
      team: team ?? null,
      individual: (session!.kind ?? 'session') === 'session' && session!.visibility === 'private',
      createdAt: session!.createdAt.toISOString(),
      lastActivityAt: session!.createdAt.toISOString(),
      kind: session!.kind as SessionKind,
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
      // M50: People is one list, so a member row carries their participant.
      participantId: participants.id,
      participantName: participants.displayName,
      deactivatedAt: users.deactivatedAt,
      deletedAt: users.deletedAt,
      avatarKey: users.avatarKey,
    })
    .from(sessionMembers)
    .innerJoin(users, eq(users.id, sessionMembers.userId))
    .leftJoin(
      participants,
      and(eq(participants.sessionId, sessionMembers.sessionId), eq(participants.userId, sessionMembers.userId), eq(participants.kind, 'human')),
    )
    .where(eq(sessionMembers.sessionId, sessionId))
    .orderBy(asc(users.displayName));

  // M58: a member whose account left is listed with the mark.
  return rows.map(({ deactivatedAt, deletedAt, avatarKey, ...r }) => ({ ...r, role: r.role as SessionRole, account: accountMark({ deactivatedAt, deletedAt }), avatarUrl: avatarUrl(avatarKey) }));
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
  opts: { viaTeamId?: string } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const insert = tx
      .insert(sessionMembers)
      .values({ sessionId, userId: user.id, role, viaTeamId: opts.viaTeamId ?? null });
    // A direct grant is the stronger one: it clears a roster origin (M21), so
    // leaving the team later doesn't take away access someone was invited to.
    // A roster add never downgrades an existing direct membership.
    if (opts.viaTeamId) await insert.onConflictDoNothing();
    else
      await insert.onConflictDoUpdate({
        target: [sessionMembers.sessionId, sessionMembers.userId],
        set: { viaTeamId: null },
      });

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
  // M58: a human participant whose account left carries the mark.
  const rows = await db
    .select({
      id: participants.id,
      sessionId: participants.sessionId,
      kind: participants.kind,
      displayName: participants.displayName,
      userId: participants.userId,
      avatarKey: users.avatarKey,
      deactivatedAt: users.deactivatedAt,
      deletedAt: users.deletedAt,
    })
    .from(participants)
    .leftJoin(users, eq(users.id, participants.userId))
    .where(eq(participants.sessionId, sessionId))
    .orderBy(asc(participants.displayName));

  return rows.map((p) => {
    const account = accountMark({ deactivatedAt: p.deactivatedAt ?? null, deletedAt: p.deletedAt ?? null });
    return {
      id: p.id,
      sessionId: p.sessionId,
      kind: p.kind as Participant['kind'],
      displayName: p.displayName,
      userId: p.kind === 'human' ? p.userId : null,
      // M67: agents never carry a picture, whoever registered them.
      avatarUrl: p.kind === 'human' ? avatarUrl(p.avatarKey) : null,
      ...(account ? { account } : {}),
    };
  });
}

export interface ListMessagesOptions {
  limit?: number;
  /** Return messages older than this message id, for paging back. */
  before?: string;
}

export async function listMessages(
  db: Database,
  sessionId: string,
  options: ListMessagesOptions | number = {},
): Promise<Message[]> {
  const { limit = 100, before } =
    typeof options === 'number' ? { limit: options, before: undefined } : options;

  let cursor: Date | undefined;
  if (before) {
    const [anchor] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.id, before), eq(messages.sessionId, sessionId)))
      .limit(1);
    // An unknown cursor returns nothing rather than silently restarting from the
    // top, which would make a paging client loop forever.
    if (!anchor) return [];
    cursor = anchor.createdAt;
  }

  const where = cursor
    ? and(eq(messages.sessionId, sessionId), lt(messages.createdAt, cursor))
    : eq(messages.sessionId, sessionId);

  // Take the NEWEST `limit` before the cursor, then flip to oldest-first. Taking
  // the oldest would page forward through history instead of back from now.
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
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  rows.reverse();

  const mentions = await mentionsForSession(db, sessionId);
  return rows.map((r) => toMessage(r, mentions.get(r.id) ?? []));
}

/**
 * Participants including the backing `user_id`.
 *
 * Trust evaluation needs to know which human owns an agent, so the MCP layer
 * needs the user behind each human participant. Not exposed over the web API —
 * it would leak internal user ids into the browser for no benefit.
 */
export async function listParticipantsWithUsers(
  db: Database,
  sessionId: string,
): Promise<(Participant & { userId: string | null })[]> {
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
    userId: p.userId,
  }));
}

/* -------------------------------------------------------------------------- */
/* Notes (M65, ADR 0059)                                                      */
/* -------------------------------------------------------------------------- */

const MAX_NOTE_CHARS = 4000;
const TAG_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A tag is one lowercase word the writer chose, or nothing. Returns null for
 * "no tag", the normalised word, or undefined when it cannot be one word.
 */
export function normalizeTag(tag: unknown): string | null | undefined {
  if (tag === undefined || tag === null || tag === '') return null;
  if (typeof tag !== 'string') return undefined;
  const word = tag.trim().toLowerCase().replace(/\s+/g, '-');
  return TAG_SHAPE.test(word) ? word : undefined;
}

const noteBy = alias(participants, 'note_by');
const noteRemovedBy = alias(participants, 'note_removed_by');

function noteRow(r: {
  id: string;
  text: string;
  tag: string | null;
  participantId: string | null;
  by: string | null;
  at: Date;
  seq: number;
  removedAt: Date | null;
  removedBy: string | null;
}): SessionNote {
  return {
    id: r.id,
    text: r.text,
    tag: r.tag,
    by: r.by,
    participantId: r.participantId,
    at: r.at.toISOString(),
    seq: Number(r.seq),
    ...(r.removedAt ? { removedAt: r.removedAt.toISOString(), removedBy: r.removedBy } : {}),
  };
}

const noteSelect = {
  id: sessionNotes.id,
  text: sessionNotes.text,
  tag: sessionNotes.tag,
  participantId: sessionNotes.participantId,
  by: noteBy.displayName,
  at: sessionNotes.createdAt,
  seq: sessionNotes.seq,
  removedAt: sessionNotes.removedAt,
  removedBy: noteRemovedBy.displayName,
};

/** The room's notes, oldest first. Live ones by default; with removed ones, the whole history. */
export async function listNotes(
  db: Database,
  sessionId: string,
  opts: { includeRemoved?: boolean } = {},
): Promise<SessionNote[]> {
  const rows = await db
    .select(noteSelect)
    .from(sessionNotes)
    .leftJoin(noteBy, eq(noteBy.id, sessionNotes.participantId))
    .leftJoin(noteRemovedBy, eq(noteRemovedBy.id, sessionNotes.removedByParticipantId))
    .where(and(eq(sessionNotes.sessionId, sessionId), opts.includeRemoved ? undefined : isNull(sessionNotes.removedAt)))
    .orderBy(asc(sessionNotes.seq));
  return rows.map(noteRow);
}

async function noteById(db: Database, id: string): Promise<SessionNote | null> {
  const [row] = await db
    .select(noteSelect)
    .from(sessionNotes)
    .leftJoin(noteBy, eq(noteBy.id, sessionNotes.participantId))
    .leftJoin(noteRemovedBy, eq(noteRemovedBy.id, sessionNotes.removedByParticipantId))
    .where(eq(sessionNotes.id, id))
    .limit(1);
  return row ? noteRow(row) : null;
}

export type AddNoteResult = { ok: true; note: SessionNote } | { ok: false; error: string };

/**
 * Write something down. Appending never touches another note, so an agent and
 * a person writing at once lose nothing (the point ADR 0013 made, kept). An
 * identical live note is returned rather than duplicated: an agent that
 * re-reads and re-adds what it knows must not make the list grow.
 */
export async function addNote(
  db: Database,
  sessionId: string,
  input: { text: string; tag?: unknown },
  actor: { participantId: string | null } = { participantId: null },
): Promise<AddNoteResult> {
  const text = (input.text ?? '').trim();
  if (!text) return { ok: false, error: 'a note needs text' };
  if (text.length > MAX_NOTE_CHARS) return { ok: false, error: `a note is at most ${MAX_NOTE_CHARS} characters` };
  const tag = normalizeTag(input.tag);
  if (tag === undefined) return { ok: false, error: 'a tag is one word: letters, digits and hyphens, up to 32' };
  const [dup] = await db
    .select({ id: sessionNotes.id })
    .from(sessionNotes)
    .where(and(eq(sessionNotes.sessionId, sessionId), eq(sessionNotes.text, text), isNull(sessionNotes.removedAt)))
    .limit(1);
  if (dup) return { ok: true, note: (await noteById(db, dup.id))! };
  const [made] = await db
    .insert(sessionNotes)
    .values({ sessionId, participantId: actor.participantId, text, tag })
    .returning({ id: sessionNotes.id });
  return { ok: true, note: (await noteById(db, made!.id))! };
}

/** Remove a note by id. Soft: it stays in the history, marked by whom and when. */
export async function removeNote(
  db: Database,
  sessionId: string,
  noteId: string,
  actor: { participantId: string | null } = { participantId: null },
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(noteId)) return false;
  const done = await db
    .update(sessionNotes)
    .set({ removedAt: new Date(), removedByParticipantId: actor.participantId })
    .where(and(eq(sessionNotes.id, noteId), eq(sessionNotes.sessionId, sessionId), isNull(sessionNotes.removedAt)))
    .returning({ id: sessionNotes.id });
  return done.length > 0;
}

/** The newest note's sequence number, for the catch-up's "since you were here". */
export async function latestNoteSeq(db: Database, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ seq: sql<number>`coalesce(max(${sessionNotes.seq}), 0)` })
    .from(sessionNotes)
    .where(eq(sessionNotes.sessionId, sessionId));
  return Number(row?.seq ?? 0);
}

/**
 * Mentions per message, with display names resolved NOW.
 *
 * Resolving at read time is what makes a rename correct retroactively — the
 * stored content holds ids, never names. See ADR 0008.
 */
async function mentionsForSession(
  db: Database,
  sessionId: string,
): Promise<Map<string, Mention[]>> {
  const rows = await db
    .select({
      messageId: messageMentions.messageId,
      participantId: participants.id,
      displayName: participants.displayName,
      kind: participants.kind,
    })
    .from(messageMentions)
    .innerJoin(messages, eq(messages.id, messageMentions.messageId))
    .innerJoin(participants, eq(participants.id, messageMentions.participantId))
    .where(eq(messages.sessionId, sessionId));

  const byMessage = new Map<string, Mention[]>();
  for (const r of rows) {
    const list = byMessage.get(r.messageId) ?? [];
    list.push({
      participantId: r.participantId,
      displayName: r.displayName,
      kind: r.kind as Participant['kind'],
    });
    byMessage.set(r.messageId, list);
  }
  return byMessage;
}

export type CreateMessageResult =
  | { ok: true; message: Message }
  | { ok: false; error: string };

/**
 * Store a message in canonical form and derive its mention rows.
 *
 * Content is rewritten to `<@participant_id>` markers and the rows come FROM
 * those markers, so content and rows cannot disagree. See ADR 0008.
 */
export async function createMessage(
  db: Database,
  sessionId: string,
  authorParticipantId: string,
  content: string,
  mentions?: string[],
): Promise<CreateMessageResult> {
  const sessionParticipants = await listParticipants(db, sessionId);

  const resolved = resolveMentions({ content, mentions, participants: sessionParticipants });
  // A foreign participant id is an error, not something to drop silently.
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const author = sessionParticipants.find((p) => p.id === authorParticipantId);
  if (!author) return { ok: false, error: 'author is not a participant in this session' };

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({ sessionId, authorParticipantId, content: resolved.content })
      .returning();

    if (resolved.mentionedParticipantIds.length > 0) {
      await tx.insert(messageMentions).values(
        resolved.mentionedParticipantIds.map((participantId) => ({
          messageId: row!.id,
          participantId,
        })),
      );
    }
    return row!;
  });

  const byId = new Map(sessionParticipants.map((p) => [p.id, p]));
  const resolvedMentions: Mention[] = resolved.mentionedParticipantIds.map((id) => {
    const p = byId.get(id)!;
    return { participantId: p.id, displayName: p.displayName, kind: p.kind };
  });

  return {
    ok: true,
    message: toMessage(
      {
        id: created.id,
        sessionId: created.sessionId,
        content: created.content,
        createdAt: created.createdAt,
        authorId: author.id,
        authorKind: author.kind,
        authorName: author.displayName,
      },
      resolvedMentions,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Participant renaming                                                       */
/* -------------------------------------------------------------------------- */

export type RenameResult =
  | { ok: true; participant: Participant }
  | { ok: false; error: string; conflict?: boolean };

/**
 * Rename a participant within a session.
 *
 * Display names are per-session on purpose: you may be `@fede` in one session
 * and `@fede-oncall` in another. Renaming never touches stored message content,
 * because content holds ids — the change is visible in old messages immediately.
 */
export async function renameParticipant(
  db: Database,
  sessionId: string,
  participantId: string,
  displayName: string,
): Promise<RenameResult> {
  const trimmed = displayName.trim();
  if (!trimmed) return { ok: false, error: 'display name is required' };
  // Mention resolution matches names in prose, so a name has to be a single
  // token that the handle pattern can actually match.
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return {
      ok: false,
      error: 'display name may contain only letters, digits, dot, hyphen and underscore',
    };
  }

  const [existing] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(eq(participants.sessionId, sessionId), eq(participants.displayName, trimmed)),
    )
    .limit(1);

  if (existing && existing.id !== participantId) {
    return { ok: false, error: 'that name is already taken in this session', conflict: true };
  }

  const [updated] = await db
    .update(participants)
    .set({ displayName: trimmed })
    .where(
      and(eq(participants.id, participantId), eq(participants.sessionId, sessionId)),
    )
    .returning();

  if (!updated) return { ok: false, error: 'no such participant in this session' };

  return {
    ok: true,
    participant: {
      id: updated.id,
      sessionId: updated.sessionId,
      kind: updated.kind as Participant['kind'],
      displayName: updated.displayName,
    },
  };
}

/** The participant row for a given user in a session, if any. */
export async function participantForUser(
  db: Database,
  sessionId: string,
  userId: string,
): Promise<Participant | null> {
  const [row] = await db
    .select()
    .from(participants)
    .where(and(eq(participants.sessionId, sessionId), eq(participants.userId, userId)))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind as Participant['kind'],
    displayName: row.displayName,
  };
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

function toMessage(r: MessageRow, mentions: Mention[]): Message {
  return {
    id: r.id,
    sessionId: r.sessionId,
    author: {
      participantId: r.authorId,
      kind: r.authorKind as Participant['kind'],
      displayName: r.authorName,
    },
    // Canonical form, with `<@id>` markers. Consumers render them.
    content: r.content,
    mentions,
    createdAt: r.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* M22 — visibility and guests. See ADR 0025 and docs/security.md, Threat 8.  */
/* -------------------------------------------------------------------------- */

export async function getVisibility(db: Database, sessionId: string): Promise<SessionVisibility> {
  const [row] = await db.select({ v: sessions.visibility }).from(sessions).where(eq(sessions.id, sessionId));
  return (row?.v as SessionVisibility | undefined) ?? 'private';
}

/** `team` needs a team: a team-visible session with no team would be visible to no one, confusingly. */
export async function setVisibility(
  db: Database,
  sessionId: string,
  visibility: SessionVisibility,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (visibility !== 'private' && visibility !== 'team') return { ok: false, error: 'visibility is private or team' };
  if (visibility === 'team') {
    const [row] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId));
    if (!row?.teamId) return { ok: false, error: 'put the session in an organization before making it visible to the organization' };
  }
  await db.update(sessions).set({ visibility }).where(eq(sessions.id, sessionId));
  return { ok: true };
}

export async function listGuests(db: Database, sessionId: string) {
  const rows = await db
    .select({ userId: users.id, displayName: users.displayName, email: users.email, avatarKey: users.avatarKey })
    .from(sessionGuests)
    .innerJoin(users, eq(users.id, sessionGuests.userId))
    .where(eq(sessionGuests.sessionId, sessionId))
    .orderBy(asc(users.displayName));
  return rows.map(({ avatarKey, ...g }) => ({ ...g, avatarUrl: avatarUrl(avatarKey) }));
}

/** A member who redeems a guest invite stays a member: never a downgrade. */
export async function addGuest(db: Database, sessionId: string, userId: string): Promise<void> {
  const member = await db
    .select({ userId: sessionMembers.userId })
    .from(sessionMembers)
    .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
    .limit(1);
  if (member.length) return;
  await db.insert(sessionGuests).values({ sessionId, userId }).onConflictDoNothing();
}

export async function removeGuest(db: Database, sessionId: string, userId: string): Promise<boolean> {
  const done = await db
    .delete(sessionGuests)
    .where(and(eq(sessionGuests.sessionId, sessionId), eq(sessionGuests.userId, userId)))
    .returning({ userId: sessionGuests.userId });
  return done.length > 0;
}

/**
 * M42: this person's setting for a room. Writes a read position when there's
 * none yet, with the context as it is now: choosing a setting means you're in
 * the room, which opening it records anyway.
 */
export async function setNotify(db: Database, sessionId: string, userId: string, notify: NotifySetting | null): Promise<void> {
  const updated = await db
    .update(sessionReads)
    .set({ notify })
    .where(and(eq(sessionReads.sessionId, sessionId), eq(sessionReads.userId, userId)))
    .returning({ sessionId: sessionReads.sessionId });
  if (updated.length) return;
  await db
    .insert(sessionReads)
    .values({
      sessionId,
      userId,
      lastSeenAt: new Date(),
      notesSeenSeq: await latestNoteSeq(db, sessionId),
      notify,
    })
    .onConflictDoUpdate({ target: [sessionReads.sessionId, sessionReads.userId], set: { notify } });
}
