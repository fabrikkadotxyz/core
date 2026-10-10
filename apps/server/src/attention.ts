/**
 * Needs you (M42, ADR 0037): one live stream per person, carrying every room's
 * counts as they change, and a `notify` event for each new item addressed to
 * them.
 *
 * Nothing here is stored. Counts come from listSessionsForUser, the same query
 * the sidebar loads, so a room the person can't see is never named: if the list
 * doesn't return it for them, they hear nothing about it.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { agents, participants, sessionAgents, sessionGuests, sessionMembers, sessions, teamMembers } from '@fabrikka/db';
import type { PersonEvent, ServerEvent, SessionSummary } from '@fabrikka/types';
import { subscribeAll } from './bus.ts';
import { renderMentions } from './mentions.ts';
import { listSessionsForUser } from './sessions.ts';

type Send = (event: PersonEvent) => void;
const streams = new Map<string, Set<Send>>();

/** A person's open page (or app window) listening. Returns its unsubscribe. */
export function addStream(userId: string, send: Send): () => void {
  let set = streams.get(userId);
  if (!set) streams.set(userId, (set = new Set()));
  set.add(send);
  return () => {
    set!.delete(send);
    if (!set!.size) streams.delete(userId);
  };
}

const sendTo = (userId: string, event: PersonEvent) => {
  for (const send of streams.get(userId) ?? []) {
    try {
      send(event);
    } catch {
      // A socket closing mid-send is cleaned up by its own close handler.
    }
  }
};

/** Everyone who might see a room: members, guests, and its team if team-visible. Filtered by the list query after. */
async function candidates(db: Database, sessionId: string): Promise<string[]> {
  const [s] = await db.select({ teamId: sessions.teamId, visibility: sessions.visibility }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!s) return [];
  const members = db.select({ id: sessionMembers.userId }).from(sessionMembers).where(eq(sessionMembers.sessionId, sessionId));
  const guests = db.select({ id: sessionGuests.userId }).from(sessionGuests).where(eq(sessionGuests.sessionId, sessionId));
  const ids = new Set([...(await members).map((r) => r.id), ...(await guests).map((r) => r.id)]);
  if (s.visibility === 'team' && s.teamId) {
    for (const r of await db.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, s.teamId))) ids.add(r.id);
  }
  return [...ids];
}

const firstLine = (text: string) => (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 140);

/** Is this event a new item for this person, and if so what does its notification say? */
async function itemFor(
  db: Database,
  sessionId: string,
  event: ServerEvent,
  userId: string,
  room: SessionSummary,
): Promise<{ title: string; body: string } | null> {
  if (room.notify === 'nothing' || room.role === 'viewer') return null;
  const where = room.kind === 'direct' ? 'a direct message' : room.title;

  if (event.type === 'message.created') {
    const [author] = await db.select({ userId: participants.userId }).from(participants).where(eq(participants.id, event.message.author.participantId)).limit(1);
    if (author?.userId === userId) return null; // your own message
    const mine = await db
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.sessionId, sessionId), eq(participants.userId, userId)));
    const mentioned = event.message.mentions.some((m) => mine.some((p) => p.id === m.participantId));
    if (!mentioned && room.notify !== 'everything') return null;
    const people = await db.select({ id: participants.id, displayName: participants.displayName }).from(participants).where(eq(participants.sessionId, sessionId));
    const who = event.message.author.kind === 'agent' ? `@${event.message.author.displayName}` : event.message.author.displayName;
    const title = room.kind === 'direct' ? who : mentioned ? `${who} mentioned you in ${where}` : `${who} in ${where}`;
    return { title, body: firstLine(renderMentions(event.message.content, people)) };
  }

  if (event.type === 'run.ended') {
    if (!['done', 'failed', 'stopped'].includes(event.run.status)) return null;
    const [owner] = await db
      .select({ ownerId: agents.ownerId })
      .from(participants)
      .innerJoin(sessionAgents, eq(sessionAgents.id, participants.sessionAgentId))
      .innerJoin(agents, eq(agents.id, sessionAgents.agentId))
      .where(eq(participants.id, event.run.participantId))
      .limit(1);
    if (owner?.ownerId !== userId) return null;
    const how = event.run.status === 'done' ? 'finished' : event.run.status === 'failed' ? 'failed' : 'was stopped';
    return { title: `@${event.run.displayName} ${how} in ${where}`, body: '' };
  }

  if (event.type === 'agents.paused' && event.paused) {
    return {
      title: `${where} is paused`,
      body: event.reason === 'turn_budget' ? 'The agents used their turn budget. Resume them when you’re ready.' : 'Someone paused the agents.',
    };
  }
  return null;
}

const RELEVANT = new Set<ServerEvent['type']>(['message.created', 'run.ended', 'agents.paused']);

/** Called once by createApp: listen to every room, and tell the people in it. */
export function startAttention(db: Database): () => void {
  return subscribeAll((sessionId, event) => {
    if (!RELEVANT.has(event.type) || streams.size === 0) return;
    void (async () => {
      const listening = (await candidates(db, sessionId)).filter((u) => streams.has(u));
      for (const userId of listening) {
        const [room] = await listSessionsForUser(db, userId, sessionId);
        if (!room) continue; // can't see it: hears nothing about it
        const ref = { ownerSlug: room.ownerSlug, publicId: room.publicId };
        sendTo(userId, { type: 'attention', ...ref, unread: !!room.unread, needsYou: room.needsYou ?? 0 });
        const item = await itemFor(db, sessionId, event, userId, room);
        if (item) sendTo(userId, { type: 'notify', ...ref, ...item, path: `/o/${ref.ownerSlug}/s/${ref.publicId}` });
      }
    })().catch((err) => console.warn(`[attention] ${(err as Error).message}`));
  });
}

/** After a person marks a room seen or changes its setting: their other pages update too. */
export async function refreshRoom(db: Database, userId: string, sessionId: string): Promise<void> {
  if (!streams.has(userId)) return;
  const [room] = await listSessionsForUser(db, userId, sessionId);
  if (room) sendTo(userId, { type: 'attention', ownerSlug: room.ownerSlug, publicId: room.publicId, unread: !!room.unread, needsYou: room.needsYou ?? 0 });
}
