/**
 * Download my data (M62): everything an instance holds about one account, as
 * one zip of JSON files and a README. The right of access and portability,
 * self-served from Settings → Account, behind the password.
 *
 * What is in it is the person's: their profile, memberships, what they wrote,
 * their connections' names (never a token), their devices, agents, call
 * records and the trail's events about them. What is not: other people's
 * messages, a room's documents, tool output, any credential. A room's record
 * is exported by its owner (M27), not here.
 */
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  agents,
  devices,
  mcpServers,
  messages,
  outputComments,
  outputEdits,
  outputs,
  participants,
  sessionGuests,
  sessionMembers,
  sessions,
  teamMcpCalls,
  teamMembers,
  teams,
  users,
  verifyPassword,
} from '@fabrikka/db';
import { auditForUser } from './audit.ts';
import { zip } from './zip.ts';
import { avatarForExport } from './avatars.ts';

export type ExportResult = { ok: true; filename: string; data: Buffer } | { ok: false; error: string; status: 401 | 404 };

/** The archive, after the password is proven again: a stolen cookie must not be enough. */
export async function exportAccount(db: Database, userId: string, password: string): Promise<ExportResult> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.deletedAt) return { ok: false, error: 'no such account', status: 404 };
  if (!(await verifyPassword(password, u.passwordHash))) return { ok: false, error: 'wrong password', status: 401 };
  const exportedAt = new Date().toISOString();

  const profile = {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    ownerSlug: u.ownerSlug,
    createdAt: u.createdAt,
    emailVerifiedAt: u.emailVerifiedAt,
    isInstanceOwner: u.isInstanceOwner,
    theme: u.theme,
    hasPicture: u.avatarKey !== null,
    preferredAgents: u.preferredAgents,
    wantedAgents: u.wantedAgents,
    deactivatedAt: u.deactivatedAt,
    deletionRequestedAt: u.deletionRequestedAt,
  };

  const organizations = await db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role, since: teamMembers.createdAt, own: teams.ownOfUserId })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teamMembers.createdAt));

  const rooms = await db
    .select({ publicId: sessions.publicId, title: sessions.title, kind: sessions.kind, role: sessionMembers.role, since: sessionMembers.createdAt, organization: teams.name, viaOrganization: sessionMembers.viaTeamId })
    .from(sessionMembers)
    .innerJoin(sessions, eq(sessions.id, sessionMembers.sessionId))
    .leftJoin(teams, eq(teams.id, sessions.teamId))
    .where(eq(sessionMembers.userId, userId))
    .orderBy(asc(sessionMembers.createdAt));
  const guestOf = await db
    .select({ publicId: sessions.publicId, title: sessions.title, since: sessionGuests.createdAt })
    .from(sessionGuests)
    .innerJoin(sessions, eq(sessions.id, sessionGuests.sessionId))
    .where(eq(sessionGuests.userId, userId));

  const mine = await db
    .select({ id: participants.id, sessionId: participants.sessionId, name: participants.displayName })
    .from(participants)
    .where(and(eq(participants.userId, userId), eq(participants.kind, 'human')));
  const participantIds = mine.map((p) => p.id);

  const wrote = participantIds.length
    ? await db
        .select({ at: messages.createdAt, content: messages.content, room: sessions.publicId, title: sessions.title, as: participants.displayName })
        .from(messages)
        .innerJoin(participants, eq(participants.id, messages.authorParticipantId))
        .innerJoin(sessions, eq(sessions.id, messages.sessionId))
        .where(inArray(messages.authorParticipantId, participantIds))
        .orderBy(asc(messages.createdAt))
    : [];

  const edits = participantIds.length
    ? await db
        .select({ at: outputEdits.createdAt, output: outputs.name, file: outputEdits.file, version: outputEdits.version, addedLines: outputEdits.addedLines, removedLines: outputEdits.removedLines, room: sessions.publicId })
        .from(outputEdits)
        .innerJoin(outputs, eq(outputs.id, outputEdits.outputId))
        .innerJoin(sessions, eq(sessions.id, outputs.sessionId))
        .where(inArray(outputEdits.participantId, participantIds))
        .orderBy(asc(outputEdits.createdAt))
    : [];

  const comments = await db
    .select({ at: outputComments.createdAt, output: outputs.name, file: outputComments.file, body: outputComments.body, status: outputComments.status, room: sessions.publicId })
    .from(outputComments)
    .innerJoin(outputs, eq(outputs.id, outputComments.outputId))
    .innerJoin(sessions, eq(sessions.id, outputs.sessionId))
    .where(eq(outputComments.authorUserId, userId))
    .orderBy(asc(outputComments.createdAt));

  // Names only: a token is a credential, and a URL may carry one in a header.
  const connections = await db
    .select({ slug: mcpServers.slug, label: mcpServers.label, url: mcpServers.url, status: mcpServers.status, auth: mcpServers.auth, organization: teams.name, createdAt: mcpServers.createdAt })
    .from(mcpServers)
    .leftJoin(teams, eq(teams.id, mcpServers.teamId))
    .where(eq(mcpServers.ownerId, userId))
    .orderBy(asc(mcpServers.createdAt));

  const computers = await db
    .select({ name: devices.name, createdAt: devices.createdAt, lastSeenAt: devices.lastSeenAt, revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(asc(devices.createdAt));

  const myAgents = await db
    .select({ name: agents.name, provider: agents.provider, createdAt: agents.createdAt })
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(asc(agents.createdAt));

  const calls = await db
    .select({ at: teamMcpCalls.createdAt, tool: teamMcpCalls.toolName, agent: teamMcpCalls.agentName, ok: teamMcpCalls.ok, room: sessions.publicId })
    .from(teamMcpCalls)
    .leftJoin(sessions, eq(sessions.id, teamMcpCalls.sessionId))
    .where(eq(teamMcpCalls.userId, userId))
    .orderBy(desc(teamMcpCalls.createdAt))
    .limit(5000);

  const activity = await auditForUser(db, userId, { limit: 1000 });

  const readme = `# Your Fabrikka data

Exported ${exportedAt} for ${u.email} (${u.displayName}).

What is here is what this instance holds about you:

- profile.json: your account, as it is now. No password: only a hash is ever stored, and it is not here.
- picture.webp (or .png, .jpg): your profile picture, if you set one.
- organizations.json, rooms.json: where you are, with your role and since when; guest-of.json, rooms you may read.
- messages.json: every message you wrote, with the room and the name you wrote it under.
- edits.json, comments.json: documents you edited (counts of lines, not the text, which is the room's record) and comments you made.
- connections.json: the services you connected, by name. Never a token.
- computers.json, agents.json: the computers you paired and the agents you registered.
- call-records.json: calls made with an organization's shared connection, attributed to you.
- activity.json: what you did, and what was done to your account, from the activity trail.

What is not here: other people's messages, a room's documents and files, tool output, and any credential.
A room's full record is exported by its owner from the room. Fabrikka's privacy policy describes all of this.
`;

  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
  // M67: the picture is theirs too, as it is stored.
  const picture = await avatarForExport(db, userId);
  const pictureExt = picture ? ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[picture.type] ?? 'img' : null;
  const data = zip([
    ...(picture ? [{ path: `picture.${pictureExt}`, data: picture.bytes }] : []),
    { path: 'README.md', data: readme },
    { path: 'profile.json', data: json(profile) },
    { path: 'organizations.json', data: json(organizations.map((o) => ({ ...o, own: o.own === userId }))) },
    { path: 'rooms.json', data: json(rooms.map((r) => ({ ...r, viaOrganization: r.viaOrganization !== null }))) },
    { path: 'guest-of.json', data: json(guestOf) },
    { path: 'messages.json', data: json(wrote) },
    { path: 'edits.json', data: json(edits) },
    { path: 'comments.json', data: json(comments) },
    { path: 'connections.json', data: json(connections) },
    { path: 'computers.json', data: json(computers) },
    { path: 'agents.json', data: json(myAgents) },
    { path: 'call-records.json', data: json(calls) },
    { path: 'activity.json', data: json(activity) },
  ]);
  const filename = `fabrikka-${u.ownerSlug}-${exportedAt.slice(0, 10)}.zip`;
  return { ok: true, filename, data };
}

/** Keeps `or` imported for the day activity is filtered here too; auditForUser does it today. */
export const _unused = { or };
