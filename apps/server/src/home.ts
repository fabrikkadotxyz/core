/**
 * The home (M56): what needs you, what is running, what changed — from what
 * the server already records, derived on each visit, never stored. One
 * read-only answer for one person; every item names its room.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  agentConnections,
  agents,
  devices,
  messageMentions,
  messages,
  participants,
  runs,
  sessionAgentHosts,
  sessionAgents,
  sessionInvites,
  sessionMembers,
  sessionReads,
  sessions,
  teams,
  users,
} from '@fabrikka/db';
import type { HomeView } from '@fabrikka/types';
import { lastActivity } from './activity.ts';
import { waitingFor } from './catchup.ts';
import { listDevices } from './devices.ts';

type Ref = { ownerSlug: string; publicId: string; title: string };

export async function homeFor(db: Database, userId: string, online: (deviceId: string) => boolean): Promise<HomeView> {
  const mine = db.select({ id: sessionMembers.sessionId }).from(sessionMembers).where(eq(sessionMembers.userId, userId));
  const seen = sql`coalesce((select sr.last_seen_at from ${sessionReads} sr where sr.session_id = ${sessions.id} and sr.user_id = ${userId}), 'epoch'::timestamptz)`;
  const ref = { ownerSlug: users.ownerSlug, publicId: sessions.publicId, title: sessions.title };
  const toRef = (r: { ownerSlug: string; publicId: string; title: string }): Ref => ({ ownerSlug: r.ownerSlug, publicId: r.publicId, title: r.title });

  // Running now: in-flight runs in rooms you are in.
  const running = await db
    .select({
      id: runs.id,
      agent: participants.displayName,
      startedAt: runs.startedAt,
      provider: runs.provider,
      // M15 slice 1: the agent reported it is waiting on a person.
      status: agentConnections.status,
      reason: agentConnections.blockedReason,
      blockedDetail: agentConnections.blockedDetail,
      ...ref,
    })
    .from(runs)
    .innerJoin(participants, eq(participants.id, runs.participantId))
    .leftJoin(agentConnections, eq(agentConnections.participantId, runs.participantId))
    .innerJoin(sessions, eq(sessions.id, runs.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(isNull(runs.endedAt), inArray(runs.sessionId, mine)))
    .orderBy(desc(runs.startedAt))
    .limit(20);

  // Finished while you were away: your agents' runs that ended since you last looked at their room.
  const finished = await db
    .select({ id: runs.id, agent: participants.displayName, status: runs.status, endedAt: runs.endedAt, ...ref })
    .from(runs)
    .innerJoin(participants, eq(participants.id, runs.participantId))
    .innerJoin(sessionAgents, eq(sessionAgents.id, participants.sessionAgentId))
    .innerJoin(agents, eq(agents.id, sessionAgents.agentId))
    .innerJoin(sessions, eq(sessions.id, runs.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(eq(agents.ownerId, userId), inArray(runs.status, ['done', 'failed', 'stopped']), sql`${runs.endedAt} > ${seen}`))
    .orderBy(desc(runs.endedAt))
    .limit(20);

  // Since you were away: rooms with messages from someone else since you last looked.
  const changed = await db
    .select({
      ...ref,
      count: sql<number>`count(*)`,
      lastAt: sql<Date>`max(${messages.createdAt})`,
    })
    .from(messages)
    .innerJoin(participants, eq(participants.id, messages.authorParticipantId))
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(inArray(messages.sessionId, mine), sql`(${participants.userId} is null or ${participants.userId} <> ${userId})`, sql`${messages.createdAt} > ${seen}`))
    .groupBy(sessions.id, sessions.publicId, sessions.title, users.ownerSlug)
    .orderBy(desc(sql`max(${messages.createdAt})`))
    .limit(20);

  // Waiting on others: the latest message in a room is yours and mentions a person.
  const latest = db
    .selectDistinctOn([messages.sessionId], { id: messages.id, sessionId: messages.sessionId })
    .from(messages)
    .where(inArray(messages.sessionId, mine))
    .orderBy(messages.sessionId, desc(messages.createdAt))
    .as('latest');
  const mentioned = sql<string>`(select string_agg(p.display_name, ', ') from ${messageMentions} mm join ${participants} p on p.id = mm.participant_id
    where mm.message_id = ${messages.id} and p.kind = 'human' and (p.user_id is null or p.user_id <> ${userId}))`;
  const waitingOn = await db
    .select({ ...ref, text: messages.content, at: messages.createdAt, to: mentioned })
    .from(latest)
    .innerJoin(messages, eq(messages.id, latest.id))
    .innerJoin(participants, eq(participants.id, messages.authorParticipantId))
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(eq(participants.userId, userId), sql`${mentioned} is not null`))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  // One-off sessions, open: links you sent for rooms in your own organization that nobody has opened.
  const openInvites = await db
    .select({ id: sessionInvites.id, createdAt: sessionInvites.createdAt, expiresAt: sessionInvites.expiresAt, ...ref })
    .from(sessionInvites)
    .innerJoin(sessions, eq(sessions.id, sessionInvites.sessionId))
    .innerJoin(teams, and(eq(teams.id, sessions.teamId), eq(teams.ownOfUserId, userId)))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(eq(sessionInvites.createdByUserId, userId), isNull(sessionInvites.redeemedAt), isNull(sessionInvites.revokedAt), gt(sessionInvites.expiresAt, new Date())))
    .orderBy(desc(sessionInvites.createdAt))
    .limit(20);

  // Your computers, with how many agents each runs.
  const bound = await db
    .select({ deviceId: sessionAgentHosts.deviceId, count: sql<number>`count(*)` })
    .from(sessionAgentHosts)
    .innerJoin(devices, eq(devices.id, sessionAgentHosts.deviceId))
    .where(eq(devices.userId, userId))
    .groupBy(sessionAgentHosts.deviceId);
  const agentsOn = new Map(bound.map((b) => [b.deviceId, Number(b.count)]));
  const computers = (await listDevices(db, userId, online)).map((d) => ({ id: d.id, name: d.name, online: d.online, agents: agentsOn.get(d.id) ?? 0 }));

  return {
    needsYou: await waitingFor(db, userId),
    running: running.map((r) => {
      const last = lastActivity(r.id);
      return {
        id: r.id,
        agent: r.agent,
        provider: r.provider,
        startedAt: r.startedAt.toISOString(),
        session: toRef(r),
        last: last ? { tool: last.tool, detail: last.detail, at: last.at } : null,
        blocked: r.status === 'blocked' ? { reason: r.reason ?? 'waiting', detail: r.blockedDetail ?? null } : null,
      };
    }),
    finished: finished.map((r) => ({ id: r.id, agent: r.agent, status: r.status as 'done' | 'failed' | 'stopped', endedAt: r.endedAt!.toISOString(), session: toRef(r) })),
    changed: changed.map((r) => ({ session: toRef(r), messages: Number(r.count), lastAt: new Date(r.lastAt).toISOString() })),
    waitingOnOthers: waitingOn.map((r) => ({ session: toRef(r), to: r.to, text: r.text.slice(0, 200), at: r.at.toISOString() })),
    openInvites: openInvites.map((r) => ({ id: r.id, session: toRef(r), createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() })),
    computers,
  };
}
