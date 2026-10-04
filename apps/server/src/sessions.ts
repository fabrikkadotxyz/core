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
import { and, asc, desc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  messageMentions,
  messages,
  participants,
  sessionContext,
  sessionGuests,
  sessionMembers,
  sessions,
  teamMembers,
  teams,
  users,
} from '@fabrikka/db';
import type {
  Mention,
  Message,
  Participant,
  Session,
  SessionContext,
  SessionVisibility,
  SessionSummary,
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
    },
  };
}

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
      teamId: teams.id,
      teamName: teams.name,
      memberCount: sql<number>`(
        select count(*) from ${sessionMembers} sm
        where sm.session_id = ${sessions.id}
      )`,
    })
    .from(sessionMembers)
    .innerJoin(sessions, eq(sessions.id, sessionMembers.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(teams, eq(teams.id, sessions.teamId))
    .where(eq(sessionMembers.userId, userId))
    .orderBy(desc(sessions.createdAt));

  const mine: SessionSummary[] = rows.map((r) => ({
    publicId: r.publicId,
    ownerSlug: r.ownerSlug,
    title: r.title,
    status: r.status as Session['status'],
    role: r.role as SessionRole,
    memberCount: Number(r.memberCount),
    team: r.teamId ? { id: r.teamId, name: r.teamName! } : null,
    createdAt: r.createdAt.toISOString(),
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
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(teams, eq(teams.id, sessions.teamId))
    .where(
      and(
        notInArray(sessions.id, memberOf),
        or(inArray(sessions.id, guestOf), and(eq(sessions.visibility, 'team'), inArray(sessions.teamId, myTeams))),
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
      createdAt: r.createdAt.toISOString(),
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Create a session. The creator becomes its owner member and gets a participant
 * row, so a session is never in a state where it exists but has nobody in it.
 */
export async function createSession(
  db: Database,
  owner: { id: string; displayName: string; ownerSlug: string },
  title: string,
  opts: { teamId?: string | null } = {},
): Promise<SessionSummary> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(sessions)
      .values({ publicId: await freePublicId(tx, title), ownerId: owner.id, title, teamId: opts.teamId ?? null })
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
/* Session context                                                            */
/* -------------------------------------------------------------------------- */

const EMPTY_CONTEXT: SessionContext = {
  objective: null,
  facts: [],
  decisions: [],
  questions: [],
  constraints: [],
  version: 0,
  updatedAt: null,
};

/** Absent context reads as empty, so callers never special-case a missing row. */
export async function getSessionContext(
  db: Database,
  sessionId: string,
): Promise<SessionContext> {
  const [row] = await db
    .select()
    .from(sessionContext)
    .where(eq(sessionContext.sessionId, sessionId))
    .limit(1);

  if (!row) return EMPTY_CONTEXT;

  return {
    objective: row.objective,
    facts: row.facts ?? [],
    decisions: row.decisions ?? [],
    questions: row.questions ?? [],
    constraints: row.constraints ?? [],
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The four list-valued context fields. */
const LIST_FIELDS = ['facts', 'decisions', 'questions', 'constraints'] as const;
type ListField = (typeof LIST_FIELDS)[number];

export interface ContextUpdate {
  objective?: string;
  /** Append, skipping exact duplicates. The path agents should take. */
  add?: Partial<Record<ListField, string[]>>;
  /** Remove by exact value — never by index, which means nothing after an append. */
  remove?: Partial<Record<ListField, string[]>>;
  /** Wholesale replacement. Requires `ifVersion`. */
  replace?: Partial<Record<ListField, string[]>>;
  ifVersion?: number;
}

export type ContextUpdateResult =
  | { ok: true; context: SessionContext }
  | { ok: false; error: string; conflict?: boolean; currentVersion?: number };

/**
 * Update session context without destroying concurrent edits.
 *
 * Append-first: `add` merges, so the common case — an agent recording something
 * it learned — cannot delete what a human typed a minute ago. Wholesale
 * replacement is still available but must carry the version the caller read, so
 * a stale writer is rejected rather than silently winning.
 *
 * See docs/decisions/0013-context-is-append-only-with-explicit-removal.md.
 */
export async function updateSessionContext(
  db: Database,
  sessionId: string,
  update: ContextUpdate,
): Promise<ContextUpdateResult> {
  // Object.keys counts keys whose VALUE is undefined, and callers build this
  // object with every field present-but-undefined. Checking values means a pure
  // `add` is not mistaken for a replace and then rejected for lacking ifVersion.
  const replacing =
    !!update.replace && Object.values(update.replace).some((v) => v !== undefined);
  if (replacing && update.ifVersion === undefined) {
    return {
      ok: false,
      error:
        'replacing a list requires ifVersion — send the version you read, or use add/remove',
    };
  }

  return db.transaction(async (tx) => {
    // Lock the row so two concurrent appends cannot both read the same list and
    // write back a merge missing the other's addition.
    const existing = await tx
      .select()
      .from(sessionContext)
      .where(eq(sessionContext.sessionId, sessionId))
      .limit(1)
      .for('update');

    const current = existing[0];
    const version = current?.version ?? 0;

    if (replacing && update.ifVersion !== version) {
      return {
        ok: false as const,
        error: 'context changed since you read it',
        conflict: true,
        currentVersion: version,
      };
    }

    const next: Record<ListField, string[]> = {
      facts: current?.facts ?? [],
      decisions: current?.decisions ?? [],
      questions: current?.questions ?? [],
      constraints: current?.constraints ?? [],
    };

    for (const field of LIST_FIELDS) {
      if (update.replace?.[field]) next[field] = [...update.replace[field]!];

      const added = update.add?.[field];
      if (added) {
        // Deduplicate: an agent that re-reads and re-adds the same fact should
        // not make the list grow every time.
        const seen = new Set(next[field]);
        for (const value of added) {
          const trimmed = value.trim();
          if (trimmed && !seen.has(trimmed)) {
            next[field].push(trimmed);
            seen.add(trimmed);
          }
        }
      }

      const removed = update.remove?.[field];
      if (removed) {
        const drop = new Set(removed.map((v) => v.trim()));
        next[field] = next[field].filter((v) => !drop.has(v));
      }
    }

    const fields = {
      ...(update.objective !== undefined ? { objective: update.objective } : {}),
      facts: next.facts,
      decisions: next.decisions,
      questions: next.questions,
      constraints: next.constraints,
      version: version + 1,
      updatedAt: new Date(),
    };

    await tx
      .insert(sessionContext)
      .values({ sessionId, ...fields })
      .onConflictDoUpdate({ target: sessionContext.sessionId, set: fields });

    const [row] = await tx
      .select()
      .from(sessionContext)
      .where(eq(sessionContext.sessionId, sessionId))
      .limit(1);

    return {
      ok: true as const,
      context: {
        objective: row!.objective,
        facts: row!.facts ?? [],
        decisions: row!.decisions ?? [],
        questions: row!.questions ?? [],
        constraints: row!.constraints ?? [],
        version: row!.version,
        updatedAt: row!.updatedAt.toISOString(),
      },
    };
  });
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
    if (!row?.teamId) return { ok: false, error: 'put the session in a team before making it team-visible' };
  }
  await db.update(sessions).set({ visibility }).where(eq(sessions.id, sessionId));
  return { ok: true };
}

export async function listGuests(db: Database, sessionId: string) {
  return db
    .select({ userId: users.id, displayName: users.displayName, email: users.email })
    .from(sessionGuests)
    .innerJoin(users, eq(users.id, sessionGuests.userId))
    .where(eq(sessionGuests.sessionId, sessionId))
    .orderBy(asc(users.displayName));
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
