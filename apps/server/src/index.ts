/**
 * Fabrikka server — M1.
 *
 * Routes are owner-scoped to mirror the MCP endpoint path exactly, so the web
 * API and the agent-facing contract cannot drift apart. See docs/protocol.md.
 *
 * Access rule, applied uniformly: anything a user may not see is a **404**,
 * never a 403. A 403 distinguishes "exists but not yours" from "doesn't exist",
 * which leaks private session ids. See docs/security.md.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createClient, isEncryptionConfigured } from '@fabrikka/db';
import type {
  LoginBody,
  PostMessageBody,
  RenameParticipantBody,
  SetupLane,
  SessionView,
  SignupBody,
} from '@fabrikka/types';
import {
  type AuthEnv,
  clearCookie,
  issueCookie,
  login,
  logout,
  pruneExpiredSessions,
  readCookie,
  requireUser,
  resolveToken,
} from './auth.ts';
import { publish, subscribe } from './bus.ts';
import { createMcpApp } from './mcp.ts';
import { broadcastAbort, onAbort, pauseState, setPaused } from './rails.ts';
import { catchUp, endRun, recordActivity, startRun } from './activity.ts';
import {
  attachServer,
  listConnections,
  removeConnection,
  saveConnection,
  detachServer,
  discoverTools,
  listGrants,
  serversForUser,
  setGrant,
  slugsInSession,
} from './aggregation.ts';
import {
  createFileArtifact,
  createLinkArtifact,
  deleteArtifact,
  listArtifacts,
  readArtifact,
} from './artifacts.ts';
import {
  connectionStatuses,
  deliverMentions,
  listenForMentions,
  setConnectionStatus,
} from './delivery.ts';
import {
  addAgentToSession,
  issueRunToken,
  issueToken,
  resolveSessionToken,
  revokeOwnToken,
  listSessionAgents,
  listSessionTokens,
  revokeToken,
  setActivityVisible,
  setAgentTrustTier,
} from './agents.ts';
import {
  createInvite,
  describeInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
} from './invites.ts';
import {
  addFile,
  attachSocket,
  createOutput,
  deleteOutput,
  isOutputId,
  listEdits,
  listOutputs,
  mountKindRoutes,
  OutputError,
  outputCreator,
  outputKinds,
  removeFile,
  renameOutput,
} from './outputs/core.ts';
import { createUser } from './users.ts';
import {
  addFromRoster,
  createTeam,
  getTeam,
  listTeamsForUser,
  membershipOrigins,
  removeTeamMember,
  roster,
  sessionTeam,
  setSessionTeam,
  TeamError,
  teamRole,
} from './teams.ts';
import { cachedRepos, LinkError, linkedRepos, listLinks, removeLink, saveLink } from './links.ts';
import { addComment, listComments, reply, setResolved, threadAuthor } from './outputs/comments.ts';
import { getCatchUp, markSeen, waitingFor } from './catchup.ts';
import { exportSession } from './export.ts';
import {
  bindAgent,
  bindingsForDevice,
  confirmPairing,
  describePairing,
  DeviceError,
  hostHub,
  hostOf,
  listDevices,
  pollPairing,
  resolveDevice,
  revokeDevice,
  setGrants,
  startPairing,
} from './devices.ts';
import { ChatError, createChat, directCandidates, ensureGeneral, listTeamChats, openDirect } from './chats.ts';
import { applyTemplate, deleteTemplate, findTemplate, listTemplates, saveTemplate, sessionTemplate, TemplateError } from './templates/templates.ts';
import {
  countOwners,
  createMessage,
  createSession,
  deleteSession,
  listMembers,
  listMessages,
  listParticipants,
  getSessionContext,
  listSessionsForUser,
  removeMember,
  renameParticipant,
  renameSession,
  resolveSessionForUser,
  resolveSessionForViewer,
  getVisibility,
  setVisibility,
  listGuests,
  removeGuest,
  setSessionStatus,
  updateSessionContext,
  type ContextUpdate,
} from './sessions.ts';

const PORT = Number(process.env.PORT ?? 9090);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');

/**
 * How to invoke the bridge, for the generated .mcp.json.
 *
 * Defaults to the published package. Point it at the local build during
 * development: BRIDGE_COMMAND="node /path/to/packages/bridge/dist/cli.js"
 */
const BRIDGE_COMMAND = (process.env.BRIDGE_COMMAND ?? 'npx -y @fabrikka/bridge')
  .split(' ')
  .filter(Boolean);

const { db } = createClient();

const app = new Hono<AuthEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

/**
 * The web dev server proxies /api to this origin, so browser requests are
 * same-origin in dev as well as production. CORS stays for direct-origin calls
 * during development and must allow credentials, since auth is cookie-based.
 */
app.use(
  '/api/*',
  cors({ origin: ['http://localhost:5173'], credentials: true }),
);

app.get('/health', (c) => c.json({ ok: true }));


/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<LoginBody>();
  if (!email || !password) {
    return c.json({ error: 'email and password are required' }, 400);
  }

  const token = await login(db, email, password);
  // One message for both "no such user" and "wrong password", so the endpoint
  // is not an account enumeration oracle.
  if (!token) return c.json({ error: 'invalid email or password' }, 401);

  issueCookie(c, token, SECURE_COOKIES);
  void pruneExpiredSessions(db);

  const user = await resolveToken(db, token);
  return c.json({ user });
});

app.post('/api/auth/logout', async (c) => {
  const token = readCookie(c);
  if (token) await logout(db, token);
  clearCookie(c, SECURE_COOKIES);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await resolveToken(db, readCookie(c));
  if (!user) return c.json({ error: 'not authenticated' }, 401);
  return c.json({ user });
});

/**
 * Signup ALWAYS requires an invite token: there is no open registration, so
 * signup and invite-acceptance are one code path rather than two (ADR 0007).
 */
app.post('/api/auth/signup', async (c) => {
  const body = await c.req.json<SignupBody>();
  if (!body.token) return c.json({ error: 'an invite token is required' }, 400);
  if (!body.email || !body.password || !body.displayName) {
    return c.json({ error: 'email, password and displayName are required' }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: 'password must be at least 8 characters' }, 400);
  }

  // Validate the invite before creating anything, so a bad token leaves no user.
  const preview = await describeInvite(db, body.token);
  if (!preview) return c.json({ error: 'invite is invalid or expired' }, 400);
  if (
    preview.invitedEmail &&
    preview.invitedEmail !== body.email.trim().toLowerCase()
  ) {
    return c.json({ error: 'this invite is for a different email address' }, 403);
  }

  const created = await createUser(db, {
    email: body.email,
    password: body.password,
    displayName: body.displayName,
  });
  if (!created.ok) return c.json({ error: created.error }, 409);

  const redeemed = await redeemInvite(db, body.token, created.user);
  if (!redeemed.ok) return c.json({ error: `invite ${redeemed.reason}` }, 400);

  const token = await login(db, body.email, body.password);
  if (token) issueCookie(c, token, SECURE_COOKIES);

  // A session invite lands you in the session; a team invite on the team (M21).
  return c.json({ user: created.user, session: redeemed.session, team: redeemed.team }, 201);
});

/* -------------------------------------------------------------------------- */
/* Invite preview and redemption                                              */
/* -------------------------------------------------------------------------- */

/** Unauthenticated: lets the invite page say which session it is for. */
app.get('/api/invites/:token', async (c) => {
  const preview = await describeInvite(db, c.req.param('token'));
  if (!preview) return c.notFound();
  return c.json(preview);
});

/** Redeem as an already-logged-in user. */
app.post('/api/invites/:token/redeem', requireUser(db), async (c) => {
  const result = await redeemInvite(db, c.req.param('token'), c.get('user'));
  if (!result.ok) return c.json({ error: result.reason }, 400);
  return c.json({ session: result.session, team: result.team });
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

app.get('/api/sessions', requireUser(db), async (c) =>
  c.json(await listSessionsForUser(db, c.get('user').id)),
);

app.post('/api/sessions', requireUser(db), async (c) => {
  const { title, teamId, templateRef } = await c.req.json<{ title?: string; teamId?: string; templateRef?: string }>();
  const trimmed = title?.trim();
  if (!trimmed) return c.json({ error: 'title is required' }, 400);
  // A team you aren't on is indistinguishable from one that doesn't exist.
  if (teamId && !(await teamRole(db, teamId, c.get('user').id))) return c.json({ error: 'no such team' }, 404);

  // M25: a template you can't use is indistinguishable from one that doesn't exist.
  const template = templateRef ? await findTemplate(db, c.get('user').id, templateRef) : null;
  if (templateRef && !template) return c.json({ error: 'no such template' }, 404);
  const created = await createSession(db, c.get('user'), trimmed, { teamId: teamId ?? null });
  if (template) {
    const s = await resolveSessionForUser(db, created.ownerSlug, created.publicId, c.get('user').id);
    await applyTemplate(db, { sessionId: s!.id, participantId: s!.participantId, template });
  }
  return c.json(created, 201);
});

/* -------------------------------------------------------------------------- */
/* Teams (M21). A list of people; nothing else. See ADR 0025.                  */
/* Every route is a 404 to someone who isn't on the team.                      */
/* -------------------------------------------------------------------------- */

app.get('/api/teams', requireUser(db), async (c) => {
  const mine = await listTeamsForUser(db, c.get('user').id);
  // Teams from before M29 get their #general the first time anyone looks.
  for (const t of mine) await ensureGeneral(db, t.id);
  return c.json(mine);
});

app.post('/api/teams', requireUser(db), async (c) => {
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  try {
    return c.json(await createTeam(db, c.get('user').id, name ?? ''), 201);
  } catch (err) {
    if (err instanceof TeamError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.get('/api/teams/:id', requireUser(db), async (c) => {
  const team = await getTeam(db, c.req.param('id'), c.get('user').id);
  return team ? c.json(team) : c.notFound();
});

app.get('/api/teams/:id/invites', requireUser(db), async (c) => {
  if ((await teamRole(db, c.req.param('id'), c.get('user').id)) !== 'owner') return c.notFound();
  return c.json(await listInvites(db, { teamId: c.req.param('id') }));
});

/** Same links as a session invite: single-use, expiring, hashed (M1, ADR 0007). */
app.post('/api/teams/:id/invites', requireUser(db), async (c) => {
  const teamId = c.req.param('id');
  if ((await teamRole(db, teamId, c.get('user').id)) !== 'owner') return c.notFound();
  const body = await c.req.json<{ invitedEmail?: string; role?: string }>().catch(() => ({}) as { invitedEmail?: string; role?: string });
  const { summary, token } = await createInvite(db, {
    teamId,
    createdByUserId: c.get('user').id,
    role: body.role === 'owner' ? 'owner' : 'member',
    invitedEmail: body.invitedEmail ?? null,
  });
  return c.json({ invite: summary, token, url: `${PUBLIC_URL}/invite/${token}` }, 201);
});

app.post('/api/teams/:id/invites/:inviteId/revoke', requireUser(db), async (c) => {
  if ((await teamRole(db, c.req.param('id'), c.get('user').id)) !== 'owner') return c.notFound();
  const revoked = await revokeInvite(db, { teamId: c.req.param('id') }, c.req.param('inviteId'));
  return revoked ? c.json({ ok: true }) : c.notFound();
});

/** An owner removes a member; anyone may remove themselves (leave). */
app.delete('/api/teams/:id/members/:userId', requireUser(db), async (c) => {
  const teamId = c.req.param('id');
  const me = c.get('user').id;
  const role = await teamRole(db, teamId, me);
  const target = c.req.param('userId');
  if (!role || (role !== 'owner' && target !== me)) return c.notFound();
  if (!(await teamRole(db, teamId, target))) return c.notFound();
  try {
    await removeTeamMember(db, teamId, target);
  } catch (err) {
    if (err instanceof TeamError) return c.json({ error: err.message }, 409);
    throw err;
  }
  return c.json({ ok: true });
});

/** M24: mentions of you across your sessions, since you last opened each. */
app.get('/api/waiting', requireUser(db), async (c) => c.json(await waitingFor(db, c.get('user').id)));

/* ---- templates (M25): a session's structure, never its content ---- */

app.get('/api/templates', requireUser(db), async (c) => c.json(await listTemplates(db, c.get('user').id)));

app.delete('/api/templates/:ref', requireUser(db), async (c) =>
  (await deleteTemplate(db, c.get('user').id, c.req.param('ref'))) ? c.json({ ok: true }) : c.notFound(),
);

/* ---- personal integrations (M28): your own connections, outside any session ---- */

app.get('/api/me/connections', requireUser(db), async (c) =>
  c.json({ connections: await listConnections(db, c.get('user').id), encryptionConfigured: isEncryptionConfigured() }),
);

app.post('/api/me/connections', requireUser(db), async (c) => {
  const body = await c.req.json<{ slug?: string; label?: string; url?: string; credential?: string }>();
  if (!body.slug || !body.url) return c.json({ error: 'slug and url are required' }, 400);
  const saved = await saveConnection(db, { userId: c.get('user').id, slug: body.slug, label: body.label, url: body.url, credential: body.credential });
  return saved.ok ? c.json(saved.server, 201) : c.json({ error: saved.error }, 400);
});

/** Removing a connection detaches it from every session it was in. */
app.delete('/api/me/connections/:slug', requireUser(db), async (c) =>
  (await removeConnection(db, c.get('user').id, c.req.param('slug'))) ? c.json({ ok: true }) : c.notFound(),
);

/* ---- chats (M29, ADR 0026): team chats and direct chats, light sessions ---- */

app.get('/api/teams/:id/chats', requireUser(db), async (c) => {
  if (!(await teamRole(db, c.req.param('id'), c.get('user').id))) return c.notFound();
  return c.json(await listTeamChats(db, c.req.param('id'), c.get('user').id));
});

/** Any team member may add a chat; everyone on the team is in it. */
app.post('/api/teams/:id/chats', requireUser(db), async (c) => {
  const teamId = c.req.param('id');
  if (!(await teamRole(db, teamId, c.get('user').id))) return c.notFound();
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  try {
    return c.json(await createChat(db, { teamId, userId: c.get('user').id, name: name ?? '' }), 201);
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/** Open (or create) the 1:1 chat with someone you share a team with. */
app.post('/api/directs', requireUser(db), async (c) => {
  const { userId } = await c.req.json<{ userId?: string }>().catch(() => ({ userId: undefined }));
  try {
    return c.json(await openDirect(db, c.get('user').id, userId ?? ''));
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message }, err.message === 'no such person' ? 404 : 400);
    throw err;
  }
});

app.get('/api/directs/people', requireUser(db), async (c) => c.json(await directCandidates(db, c.get('user').id)));

/* ---- the local host (M31, ADR 0027): pairing and devices ---- */

/** Unauthenticated: the host asks to pair and gets a code for a person to confirm. */
app.post('/api/devices/pair', async (c) => {
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  return c.json(await startPairing(db, name ?? ''), 201);
});

/** Unauthenticated: the host polls; once confirmed it receives its token, once. */
app.post('/api/devices/pair/poll', async (c) => {
  const { deviceCode } = await c.req.json<{ deviceCode?: string }>().catch(() => ({ deviceCode: undefined }));
  return c.json(await pollPairing(db, deviceCode ?? ''));
});

/** What the /pair page shows: the device's name for a live code. */
app.get('/api/devices/pair/:code', requireUser(db), async (c) => {
  const p = await describePairing(db, c.req.param('code'));
  return p ? c.json(p) : c.notFound();
});

app.post('/api/devices/pair/confirm', requireUser(db), async (c) => {
  const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: undefined }));
  try {
    return c.json(await confirmPairing(db, c.get('user').id, code ?? ''));
  } catch (err) {
    if (err instanceof DeviceError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.get('/api/devices', requireUser(db), async (c) => c.json(await listDevices(db, c.get('user').id, hostHub.online)));

app.delete('/api/devices/:id', requireUser(db), async (c) => {
  const done = await revokeDevice(db, c.get('user').id, c.req.param('id'));
  if (!done) return c.notFound();
  hostHub.kick(c.req.param('id'));
  return c.json({ ok: true });
});

const sessionRoutes = new Hono<AuthEnv>();

sessionRoutes.use('*', requireUser(db));

sessionRoutes.get('/', async (c) => {
  // Readable by viewers (M22) — but a viewer's view leaves out the member list
  // (emails) and everything Setup holds (docs/security.md, Threat 8).
  const s = await resolveViewer(c);
  if (!s) return c.notFound();

  const statuses = await connectionStatuses(db, s.id);
  const viewer = s.access === 'viewer';
  const view: SessionView = {
    agents: await pauseState(db, s.id),
    session: s.view,
    participants: (await listParticipants(db, s.id)).map((p) => ({
      ...p,
      status: statuses.get(p.id),
    })),
    members: viewer ? [] : await membersWithOrigin(s.id),
    me: { role: s.role, participantId: s.participantId },
    mcpEndpoint: viewer ? '' : `${PUBLIC_URL}/mcp/o/${s.view.ownerSlug}/s/${s.view.publicId}`,
    visibility: await getVisibility(db, s.id),
    ...(s.role === 'owner' ? { guests: await listGuests(db, s.id) } : {}),
  };
  return c.json(view);
});

sessionRoutes.patch('/', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  // Only owners mutate the session itself. A member gets 404 rather than 403:
  // from their perspective the mutable resource does not exist.
  if (s.role !== 'owner') return c.notFound();

  const body = await c.req.json<{ title?: string; status?: 'active' | 'archived'; visibility?: string }>();

  // M22: making a session team-visible is the owner's deliberate act.
  if (body.visibility !== undefined) {
    if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);
    const set = await setVisibility(db, s.id, body.visibility as 'private' | 'team');
    if (!set.ok) return c.json({ error: set.error }, 400);
  }

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return c.json({ error: 'title cannot be empty' }, 400);
    await renameSession(db, s.id, title);
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'archived') {
      return c.json({ error: 'status must be active or archived' }, 400);
    }
    await setSessionStatus(db, s.id, body.status);
  }

  return c.json({ ok: true });
});

sessionRoutes.delete('/', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  await deleteSession(db, s.id);
  return c.json({ ok: true });
});

sessionRoutes.get('/messages', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await listMessages(db, s.id));
});

sessionRoutes.post('/messages', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const body = await c.req.json<PostMessageBody>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content is required' }, 400);

  // The author is the caller's own participant row — never client-supplied.
  const result = await createMessage(
    db,
    s.id,
    s.participantId,
    content,
    body.mentions,
  );
  // A mention referencing another session's participant is refused, not dropped.
  if (!result.ok) return c.json({ error: result.error }, 400);

  publish(s.id, { type: 'message.created', message: result.message });
  // Mentions of agents are evaluated and pushed here, not in the bridge. A
  // failure here must not lose the message that was already stored — but it must
  // also not be swallowed, because silent non-delivery is the failure mode this
  // whole subsystem exists to avoid (ADR 0010).
  await deliverMentions(db, s.id, result.message).catch((err) => {
    console.error('[delivery] failed for message', result.message.id, err);
  });

  return c.json(result.message, 201);
});

/* ---- participants ---- */

sessionRoutes.get('/participants', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await listParticipants(db, s.id));
});

/**
 * Rename a participant.
 *
 * You may rename yourself in any session you're in; a session owner may rename
 * anyone, which is what agents will need at M3. Stored message content holds
 * ids, so old messages pick up the new name immediately (ADR 0008).
 */
sessionRoutes.patch('/participants/:id', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const targetId = c.req.param('id');
  const isSelf = targetId === s.participantId;
  // Not your participant and not your session: as far as you're concerned it
  // isn't there.
  if (!isSelf && s.role !== 'owner') return c.notFound();

  const body = await c.req.json<RenameParticipantBody>();
  const result = await renameParticipant(db, s.id, targetId, body.displayName ?? '');

  if (!result.ok) {
    if (result.error === 'no such participant in this session') return c.notFound();
    return c.json({ error: result.error }, result.conflict ? 409 : 400);
  }

  publish(s.id, { type: 'participant.updated', participant: result.participant });
  return c.json(result.participant);
});

/* ---- members ---- */

sessionRoutes.get('/members', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  return c.json(await membersWithOrigin(s.id));
});

sessionRoutes.delete('/members/:userId', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  // A team chat's members are the team (ADR 0026): leave the team to leave it.
  if (s.view.kind === 'chat') return c.json({ error: "a team chat's members are the team" }, 400);

  const userId = c.req.param('userId');
  const members = await listMembers(db, s.id);
  const target = members.find((m) => m.userId === userId);
  if (!target) return c.notFound();

  // Refuse to leave a session ownerless — it would be unreachable and
  // unmanageable, with no path to recover it through the API.
  if (target.role === 'owner' && (await countOwners(db, s.id)) <= 1) {
    return c.json({ error: 'a session must keep at least one owner' }, 409);
  }

  await removeMember(db, s.id, userId);
  return c.json({ ok: true });
});

/* ---- since you were away (M24). Viewers too: catch-up only reads, and "seen"
   writes nothing but the caller's own read position. ---- */

sessionRoutes.get('/catch-up', async (c) => {
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await getCatchUp(db, s.id, c.get('user').id));
});

sessionRoutes.post('/seen', async (c) => {
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  await markSeen(db, s.id, c.get('user').id);
  return c.json({ ok: true });
});

/* ---- this session's template (M25) ---- */

/** Which template it started from, for suggested connections. Members only. */
sessionRoutes.get('/template', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  return c.json(await sessionTemplate(db, c.get('user').id, s.id));
});

/** Save this session's structure as a template. The owner's call. */
sessionRoutes.post('/template', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  const body = await c.req.json<{ name?: string; description?: string; teamId?: string | null }>();
  try {
    return c.json(
      await saveTemplate(db, { sessionId: s.id, userId: c.get('user').id, name: body.name ?? '', description: body.description, teamId: body.teamId ?? null }),
      201,
    );
  } catch (err) {
    if (err instanceof TemplateError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/* ---- export (M27): the record is yours. The owner's deliberate act. ---- */

sessionRoutes.get('/export', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  const { filename, data } = await exportSession(db, {
    sessionId: s.id,
    session: { title: s.view.title, publicId: s.view.publicId, ownerSlug: s.view.ownerSlug, createdAt: s.view.createdAt },
    exportedBy: c.get('user').displayName,
  });
  // An ASCII fallback, and the real name per RFC 5987 for anything that reads it.
  const ascii = filename.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '');
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
});

/* ---- start a session from a chat (M29): a link back, nothing copied ---- */

sessionRoutes.post('/spin-off', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  if ((s.view.kind ?? 'session') === 'session') return c.json({ error: 'this is already a session' }, 400);
  const { title } = await c.req.json<{ title?: string }>();
  if (!title?.trim()) return c.json({ error: 'title is required' }, 400);
  const created = await createSession(db, c.get('user'), title.trim(), { teamId: s.view.kind === 'chat' ? (s.view.teamId ?? null) : null });
  const fresh = await resolveSessionForUser(db, created.ownerSlug, created.publicId, c.get('user').id);
  await saveLink(db, {
    sessionId: fresh!.id,
    participantId: fresh!.participantId,
    input: {
      url: `${PUBLIC_URL}/o/${s.view.ownerSlug}/s/${s.view.publicId}`,
      type: 'page',
      title: s.view.kind === 'chat' ? `Started from #${s.view.title}` : 'Started from a direct chat',
      provider: 'fabrikka',
    },
  });
  return c.json(created, 201);
});

/* ---- "Add my agent" (M31): an agent that runs on one of your paired devices ---- */

sessionRoutes.post('/agents/host', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const body = await c.req.json<{ deviceId?: string; grantId?: string; displayName?: string }>();
  try {
    const agent = await bindAgent(db, {
      sessionId: s.id,
      sessionPublicId: s.view.publicId,
      ownerSlug: s.view.ownerSlug,
      publicUrl: PUBLIC_URL,
      user: c.get('user'),
      deviceId: body.deviceId ?? '',
      grantId: body.grantId ?? '',
      displayName: body.displayName,
    });
    // Only the new binding goes out, with its own token: re-minting the others
    // would revoke tokens that running agents are using.
    const [binding] = await bindingsForDevice(db, body.deviceId!, PUBLIC_URL, agent.sessionAgentId);
    if (binding) hostHub.send(body.deviceId!, { type: 'binding', binding });
    return c.json({ agent, online: hostHub.online(body.deviceId!) }, 201);
  } catch (err) {
    if (err instanceof DeviceError) return c.json({ error: err.message }, err.message === 'no such device' ? 404 : 400);
    throw err;
  }
});

/** Where each of this session's agents runs, for agents bound to a device. */
sessionRoutes.get('/agents/hosts', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const out: Record<string, { deviceName: string; label: string | null; online: boolean }> = {};
  for (const a of await listSessionAgents(db, s.id)) {
    const h = await hostOf(db, a.sessionAgentId);
    if (h) out[a.participantId] = { deviceName: h.deviceName, label: h.label, online: hostHub.online(h.deviceId) };
  }
  return c.json(out);
});

/* ---- guests (M22): a viewer of this one session, from outside its team ---- */

sessionRoutes.delete('/guests/:userId', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  return (await removeGuest(db, s.id, c.req.param('userId'))) ? c.json({ ok: true }) : c.notFound();
});

/* ---- the session's team (M21) ---- */

/** Any member may see which team a session is in; only the owner may change it. */
sessionRoutes.get('/team', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  return c.json(await sessionTeam(db, s.id));
});

sessionRoutes.put('/team', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  // Chats (M29) don't take invites, roster adds, a team change or visibility.
  if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);
  const { teamId } = await c.req.json<{ teamId?: string | null }>();
  if (teamId && !(await teamRole(db, teamId, c.get('user').id))) return c.json({ error: 'no such team' }, 404);
  await setSessionTeam(db, s.id, teamId ?? null);
  return c.json(await sessionTeam(db, s.id));
});

/** Teammates not yet in the session. Owner only: adding is the owner's call. */
sessionRoutes.get('/roster', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  return c.json(await roster(db, s.id));
});

/** Add a teammate directly — no link, because the server knows who they are. */
sessionRoutes.post('/members', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  // Chats (M29) don't take invites, roster adds, a team change or visibility.
  if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);
  const { userId } = await c.req.json<{ userId?: string }>();
  try {
    await addFromRoster(db, s.id, userId ?? '');
  } catch (err) {
    if (err instanceof TeamError) return c.json({ error: err.message }, 400);
    throw err;
  }
  return c.json({ ok: true }, 201);
});

/* ---- agents ---- */

sessionRoutes.get('/agents', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  return c.json(await listSessionAgents(db, s.id));
});

/**
 * Add an agent and issue its token in one step.
 *
 * Returns the plaintext token exactly once, plus a ready-to-paste
 * `claude mcp add` command — the point of M3 is that connecting an agent is one
 * copy-paste, not a configuration exercise.
 */
sessionRoutes.post('/agents', async (c) => {
  const s = await resolve(c);
  // ANY member may add their OWN agent. Agents are per-user (agents.owner_id),
  // and the multi-participant story requires @claude-fede and @claude-alice to
  // coexist — if only the session owner could add one, Alice could never bring
  // an agent or, by ADR 0004, her own credentials.
  if (!s) return c.notFound();

  type Body = { displayName?: string; provider?: string; label?: string };
  const body: Body = await c.req.json<Body>().catch(() => ({}));
  const displayName = body.displayName?.trim();
  if (!displayName) return c.json({ error: 'displayName is required' }, 400);

  const result = await addAgentToSession(db, {
    sessionId: s.id,
    ownerUserId: c.get('user').id,
    displayName,
    provider: body.provider?.trim() || 'other',
    label: body.label,
    publicUrl: PUBLIC_URL,
    ownerSlug: s.view.ownerSlug,
    sessionPublicId: s.view.publicId,
  });
  if (!result.ok) return c.json({ error: result.error }, 409);

  const { agent, token, mcpUrl } = result.created;
  publish(s.id, {
    type: 'participant.updated',
    participant: {
      id: agent.participantId,
      sessionId: s.id,
      kind: 'agent',
      displayName: agent.displayName,
    },
  });

  return c.json({ ...agentSetup(mcpUrl, token, agent.provider), agent }, 201);
});

sessionRoutes.patch('/agents/:sessionAgentId/trust', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const { trustTier } = await c.req.json<{ trustTier?: string }>();
  if (trustTier !== 'owner_only' && trustTier !== 'session_trusted') {
    return c.json({ error: 'trustTier must be owner_only or session_trusted' }, 400);
  }

  // Elevating an agent decides who may drive something that holds ITS OWNER's
  // filesystem and tokens. That is the agent owner's call, not the session
  // owner's — a session owner must not be able to open up someone else's agent.
  const agents = await listSessionAgents(db, s.id);
  const target = agents.find((a) => a.sessionAgentId === c.req.param('sessionAgentId'));
  if (!target) return c.notFound();
  if (target.ownerUserId !== c.get('user').id) return c.notFound();

  const done = await setAgentTrustTier(db, s.id, c.req.param('sessionAgentId'), trustTier);
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/**
 * Whether this agent's steps are streamed to the session.
 *
 * The AGENT OWNER's call, like trust elevation: it is their machine and their
 * private work being described, not the session's (ADR 0015).
 */
sessionRoutes.patch('/agents/:sessionAgentId/activity', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const { visible } = await c.req.json<{ visible?: boolean }>();
  if (typeof visible !== 'boolean') {
    return c.json({ error: 'visible must be a boolean' }, 400);
  }

  const agentList = await listSessionAgents(db, s.id);
  const target = agentList.find((a) => a.sessionAgentId === c.req.param('sessionAgentId'));
  if (!target) return c.notFound();
  if (target.ownerUserId !== c.get('user').id) return c.notFound();

  const done = await setActivityVisible(db, s.id, c.req.param('sessionAgentId'), visible);
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/* ---- tokens ---- */

sessionRoutes.get('/tokens', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  return c.json(await listSessionTokens(db, s.id));
});

sessionRoutes.post('/tokens', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();

  const body = await c.req
    .json<{ participantId?: string; label?: string }>()
    .catch(() => ({}) as { participantId?: string; label?: string });
  if (!body.participantId) return c.json({ error: 'participantId is required' }, 400);

  const token = await issueToken(db, {
    sessionId: s.id,
    participantId: body.participantId,
    createdByUserId: c.get('user').id,
    label: body.label,
  });
  if (!token) return c.notFound();

  const mcpUrl = `${PUBLIC_URL}/mcp/o/${s.view.ownerSlug}/s/${s.view.publicId}`;
  // The lane set depends on the provider, so it comes from the participant's
  // agent record rather than being guessed.
  const agents = await listSessionAgents(db, s.id);
  const provider =
    agents.find((a) => a.participantId === body.participantId)?.provider ?? 'other';
  return c.json(agentSetup(mcpUrl, token, provider), 201);
});

sessionRoutes.post('/tokens/:id/revoke', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  const done = await revokeToken(db, s.id, c.req.param('id'));
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/* ---- safety rails ---- */

sessionRoutes.get('/pause', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  return c.json(await pauseState(db, s.id));
});

/**
 * The kill switch.
 *
 * Any member can pull it: if an agent is misbehaving, waiting for the owner is
 * the wrong failure mode. Halting delivery is absolute; aborting in-flight runs
 * is a request the runners may or may not honour (ADR 0012).
 */
sessionRoutes.post('/pause', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  await setPaused(db, s.id, true, 'manual');
  const asked = broadcastAbort(s.id);

  return c.json({ ...(await pauseState(db, s.id)), connectionsAskedToAbort: asked });
});

sessionRoutes.delete('/pause', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  await setPaused(db, s.id, false);
  return c.json(await pauseState(db, s.id));
});

/* ---- context ---- */

sessionRoutes.get('/context', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await getSessionContext(db, s.id));
});

sessionRoutes.patch('/context', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const body = await c.req.json<ContextUpdate>();
  const result = await updateSessionContext(db, s.id, body, { participantId: s.participantId });

  // 409 rather than a silent overwrite: the browser reloads and shows what
  // changed, instead of one of two people's edits disappearing (ADR 0013).
  if (!result.ok) {
    return c.json(
      { error: result.error, currentVersion: result.currentVersion },
      result.conflict ? 409 : 400,
    );
  }

  publish(s.id, { type: 'context.updated', context: result.context });
  return c.json(result.context);
});

/* ---- integrations (MCP aggregation) ---- */

/**
 * What THIS member has attached, plus which integrations exist in the session.
 *
 * Deliberately two lists: you see your own credentials' servers, and you see that
 * an integration exists so grants make sense — but never whose credential is
 * behind someone else's.
 */
sessionRoutes.get('/integrations', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const mine = await serversForUser(db, s.id, c.get('user').id);
  return c.json({
    mine,
    // M28: your connections not yet in this session, offered to attach.
    available: (await listConnections(db, c.get('user').id)).filter((x) => !mine.some((m) => m.id === x.id)),
    inSession: await slugsInSession(db, s.id),
    grants: await listGrants(db, s.id),
    encryptionConfigured: isEncryptionConfigured(),
  });
});

sessionRoutes.post('/integrations', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const body = await c.req.json<{
    slug?: string;
    label?: string;
    url?: string;
    credential?: string;
  }>();
  // A url saves (or updates) the connection; a slug alone attaches one you
  // already have, from Personal integrations (M28).
  if (!body.slug) return c.json({ error: 'slug is required' }, 400);

  const result = await attachServer(db, {
    sessionId: s.id,
    userId: c.get('user').id,
    slug: body.slug,
    label: body.label,
    url: body.url,
    credential: body.credential,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  return c.json(result.server, 201);
});

sessionRoutes.delete('/integrations/:slug', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const done = await detachServer(db, s.id, c.get('user').id, c.req.param('slug'));
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/** Tools an integration offers, so an owner can choose what to permit. */
sessionRoutes.get('/integrations/:slug/tools', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const mine = await serversForUser(db, s.id, c.get('user').id);
  const server = mine.find((m) => m.slug === c.req.param('slug'));
  if (!server) return c.notFound();

  return c.json(await discoverTools(db, server.id));
});

/**
 * Grant or revoke one tool for the whole session.
 *
 * Owner-only, and keyed by the integration's slug rather than by whose row it is:
 * what the session permits is a property of the session (ADR 0014).
 */
sessionRoutes.put('/integrations/:slug/tools/:tool', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();

  const { allowed } = await c.req.json<{ allowed?: boolean }>();
  await setGrant(db, s.id, c.req.param('slug'), c.req.param('tool'), allowed === true);
  return c.json({ ok: true });
});

/* ---- artifacts ---- */

sessionRoutes.get('/artifacts', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await listArtifacts(db, s.id));
});

sessionRoutes.post('/artifacts', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return c.json({ error: 'no file provided' }, 400);

    const result = await createFileArtifact(db, {
      sessionId: s.id,
      participantId: s.participantId,
      name: (form.name as string) || file.name,
      contentType: file.type || null,
      content: Buffer.from(await file.arrayBuffer()),
    });
    if (!result.ok) return c.json({ error: result.error }, 400);

    publish(s.id, { type: 'artifact.created', artifact: result.artifact });
    return c.json(result.artifact, 201);
  }

  const body = await c.req.json<{ name?: string; url?: string }>();
  if (!body.url) return c.json({ error: 'a url is required for a link' }, 400);

  const result = await createLinkArtifact(db, {
    sessionId: s.id,
    participantId: s.participantId,
    name: body.name ?? body.url,
    url: body.url,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  publish(s.id, { type: 'artifact.created', artifact: result.artifact });
  return c.json(result.artifact, 201);
});

sessionRoutes.get('/artifacts/:id/content', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();

  const found = await readArtifact(db, s.id, c.req.param('id'));
  if (!found) return c.notFound();

  return new Response(new Uint8Array(found.content), {
    headers: {
      'Content-Type': found.artifact.contentType ?? 'application/octet-stream',
      // Always an attachment: a session file is not ours to render inline, and
      // serving arbitrary uploaded HTML from our origin would be an XSS vector.
      'Content-Disposition': `attachment; filename="${found.artifact.name.replace(/"/g, '')}"`,
    },
  });
});

sessionRoutes.delete('/artifacts/:id', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const done = await deleteArtifact(db, s.id, c.req.param('id'));
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/* ---- invites ---- */

/* ---- links (M19): pointers to outside things. Any member, like context. ---- */

sessionRoutes.get('/links', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await listLinks(db, s.id));
});

sessionRoutes.put('/links', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const body = await c.req.json<{ url?: string; type?: string; title?: string; status?: string; provider?: string }>();
  try {
    const link = await saveLink(db, {
      sessionId: s.id,
      participantId: s.participantId,
      input: { url: body.url ?? '', type: body.type ?? '', title: body.title, status: body.status, provider: body.provider },
    });
    return c.json(link);
  } catch (err) {
    if (err instanceof LinkError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

sessionRoutes.delete('/links', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  try {
    if (!(await removeLink(db, s.id, c.req.query('url') ?? ''))) return c.notFound();
  } catch (err) {
    if (err instanceof LinkError) return c.json({ error: err.message }, 400);
    throw err;
  }
  return c.json({ ok: true });
});

/* ---- outputs (M12): live documents. See ADR 0019. ---- */

/** The catalogue: what kinds of output this instance offers. */
sessionRoutes.get('/output-kinds', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(outputKinds());
});

sessionRoutes.get('/outputs', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return c.json(await listOutputs(db, s.id));
});

sessionRoutes.post('/outputs', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const body = await c.req.json<{ kind?: string; name?: string }>();
  try {
    const output = await createOutput(db, {
      sessionId: s.id,
      participantId: s.participantId,
      kind: body.kind ?? '',
      name: body.name ?? '',
    });
    return c.json(output, 201);
  } catch (err) {
    if (err instanceof OutputError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/** Any member may rename: a name is shared furniture, like the context. */
sessionRoutes.patch('/outputs/:id', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: 'a name is required' }, 400);
  if (!(await renameOutput(db, s.id, c.req.param('id'), name, s.participantId))) return c.notFound();
  return c.json({ ok: true });
});

/**
 * Removing a document the whole room is writing is not a member's call to make
 * for everyone: its creator or the session owner. Everyone else gets 404.
 */
sessionRoutes.delete('/outputs/:id', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const id = c.req.param('id');
  const creator = await outputCreator(db, s.id, id);
  if (!creator || (creator !== s.participantId && s.role !== 'owner')) return c.notFound();
  await deleteOutput(db, s.id, id);
  return c.json({ ok: true });
});

/** Files of a multi-file output (a paper's sections). Any member, like typing. */
sessionRoutes.post('/outputs/:id/files', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const { path } = await c.req.json<{ path?: string }>();
  try {
    await addFile(db, { sessionId: s.id, outputId: c.req.param('id'), participantId: s.participantId, path: path?.trim() ?? '' });
    return c.json({ ok: true }, 201);
  } catch (err) {
    if (err instanceof OutputError) return err.code === 'not_found' ? c.notFound() : c.json({ error: err.message }, 400);
    throw err;
  }
});

sessionRoutes.delete('/outputs/:id/files', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  const path = c.req.query('path') ?? '';
  try {
    await removeFile(db, { sessionId: s.id, outputId: c.req.param('id'), participantId: s.participantId, path });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof OutputError) return err.code === 'not_found' ? c.notFound() : c.json({ error: err.message }, 400);
    throw err;
  }
});

/** Each output kind's own routes: public assets, session-scoped config (ADR 0023). */
mountKindRoutes(app, sessionRoutes, { member: resolve, viewer: resolveViewer });

sessionRoutes.get('/outputs/:id/changes', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  const id = c.req.param('id');
  if (!isOutputId(id) || !(await outputCreator(db, s.id, id))) return c.notFound();
  return c.json(await listEdits(db, s.id, { outputId: id }));
});

/* ---- comments on outputs (M23). Viewers and guests comment too: the one write
   on their allowlist (docs/security.md, Threat 8). A comment wakes no agent. ---- */

async function commentCall(c: Context<AuthEnv>, fn: () => Promise<unknown>) {
  try {
    return c.json(await fn());
  } catch (err) {
    if (err instanceof OutputError) {
      return err.code === 'not_found' ? c.notFound() : c.json({ error: err.message, code: err.code }, 400);
    }
    throw err;
  }
}

sessionRoutes.get('/outputs/:id/comments', async (c) => {
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  return commentCall(c, () => listComments(db, s.id, c.req.param('id')));
});

sessionRoutes.post('/outputs/:id/comments', async (c) => {
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  const body = await c.req.json<{ quote?: string; body?: string; file?: string }>();
  return commentCall(c, async () => ({
    id: await addComment(db, {
      sessionId: s.id,
      outputId: c.req.param('id'),
      userId: c.get('user').id,
      file: body.file,
      quote: body.quote ?? '',
      body: body.body ?? '',
    }),
  }));
});

sessionRoutes.post('/outputs/:id/comments/:cid/replies', async (c) => {
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  const body = await c.req.json<{ body?: string }>();
  return commentCall(c, async () => ({
    id: await reply(db, {
      sessionId: s.id,
      outputId: c.req.param('id'),
      userId: c.get('user').id,
      commentId: c.req.param('cid'),
      body: body.body ?? '',
    }),
  }));
});

/** Members resolve any thread; a viewer only one they started. */
for (const action of ['resolve', 'reopen'] as const) {
  sessionRoutes.post(`/outputs/:id/comments/:cid/${action}`, async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    const outputId = c.req.param('id');
    const commentId = c.req.param('cid');
    if (s.access === 'viewer' && (await threadAuthor(db, s.id, outputId, commentId)) !== c.get('user').id) {
      return c.notFound();
    }
    return commentCall(c, async () => {
      await setResolved(db, { sessionId: s.id, outputId, userId: c.get('user').id, commentId, resolved: action === 'resolve' });
      return { ok: true };
    });
  });
}

/**
 * Recent agent edits across the session, so the timeline can show them after a
 * reload. Human typing is in each output's changes view, not the conversation.
 */
sessionRoutes.get('/output-edits', async (c) => {
  // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
  const s = await resolveViewer(c);
  if (!s) return c.notFound();
  const edits = await listEdits(db, s.id, { agentsOnly: true, limit: 100 });
  return c.json(edits.map(({ diff: _diff, ...summary }) => summary));
});

sessionRoutes.get('/invites', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  return c.json(await listInvites(db, { sessionId: s.id }));
});

/**
 * Creating an invite returns the plaintext token exactly once. The UI copies
 * `url` to the clipboard; delivery is out of band, by design (ADR 0007).
 */
sessionRoutes.post('/invites', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  // Chats (M29) don't take invites, roster adds, a team change or visibility.
  if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);

  type InviteBody = {
    invitedEmail?: string;
    role?: 'owner' | 'member' | 'guest';
    ttlDays?: number;
  };
  // An empty body is valid: it means "a default member invite".
  const body: InviteBody = await c.req.json<InviteBody>().catch(() => ({}));

  const { summary, token } = await createInvite(db, {
    sessionId: s.id,
    createdByUserId: c.get('user').id,
    // `guest` (M22): a viewer of this one session. Anything else unknown is a member.
    role: body.role === 'owner' ? 'owner' : body.role === 'guest' ? ('guest' as never) : 'member',
    invitedEmail: body.invitedEmail ?? null,
    ttlDays: body.ttlDays,
  });

  return c.json(
    { invite: summary, token, url: `${PUBLIC_URL}/invite/${token}` },
    201,
  );
});

sessionRoutes.post('/invites/:id/revoke', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();

  const revoked = await revokeInvite(db, { sessionId: s.id }, c.req.param('id'));
  if (!revoked) return c.notFound();
  return c.json({ ok: true });
});

/**
 * The bridge socket — lane B.
 *
 * Authenticated with the same participant-scoped bearer token as the MCP
 * endpoint, sent as a header (possible because the bridge is a Node process, not
 * a browser). The server decides what to push; the bridge is a dumb pipe.
 * See ADR 0010 and docs/protocol.md.
 */
app.get(
  '/bridge/o/:owner/s/:session',
  upgradeWebSocket((c) => {
    const ownerSlug = c.req.param('owner');
    const sessionPublicId = c.req.param('session');
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

    let unsubscribe: (() => void) | undefined;
    let unsubscribeAbort: (() => void) | undefined;
    let actorRef: { sessionId: string; participantId: string } | undefined;
    /**
     * `bridge` pushes into a live agent session; `runner` spawns a headless run.
     * Defaults to bridge so an older client keeps working, and is re-registered
     * when a `hello` frame declares otherwise.
     */
    let kind: 'bridge' | 'runner' = 'bridge';

    /**
     * Frames are handled ONE AT A TIME. Every handler below awaits the database,
     * so two frames arriving back to back would otherwise interleave and publish
     * out of order — "posted a reply" landing before the read it was based on.
     * An activity feed that reorders steps is worse than no feed at all.
     */
    let queue: Promise<void> = Promise.resolve();

    const handleFrame = async (
      evt: { data: unknown },
      ws: { send: (data: string) => void },
    ): Promise<void> => {
      if (!actorRef) return;
      try {
        const frame = JSON.parse(String(evt.data)) as {
          type?: string;
          status?: string;
          kind?: string;
          runId?: string;
          provider?: string;
          messageId?: string;
          tool?: string;
          detail?: string | null;
        };

        /**
         * Run lifecycle and activity. Deliberately NOT routed through
         * deliverMentions or claimTurn: activity is display data, not a
         * delivery, and must neither reach another agent nor consume budget
         * (ADR 0015).
         */
        if (frame.type === 'run.start' && frame.runId) {
          await startRun(db, {
            runId: frame.runId,
            sessionId: actorRef.sessionId,
            participantId: actorRef.participantId,
            kind: frame.kind === 'channel' ? 'channel' : 'spawn',
            provider: frame.provider,
            triggerMessageId: frame.messageId,
          });
          return;
        }

        if (frame.type === 'activity' && frame.runId && frame.tool) {
          await recordActivity(db, {
            runId: frame.runId,
            sessionId: actorRef.sessionId,
            participantId: actorRef.participantId,
            tool: frame.tool,
            detail: frame.detail ?? null,
          });
          return;
        }

        if (frame.type === 'run.end' && frame.runId) {
          const status =
            frame.status === 'stopped' || frame.status === 'failed'
              ? frame.status
              : 'done';
          await endRun(db, {
            runId: frame.runId,
            sessionId: actorRef.sessionId,
            participantId: actorRef.participantId,
            status,
          });
          return;
        }

        // Declaring `runner` re-registers the listener under that kind, so a
        // live bridge elsewhere still wins the mention (ADR 0011).
        if (frame.type === 'hello') {
          if (frame.kind !== 'runner' && frame.kind !== 'bridge') return;
          if (frame.kind === kind) return;

          kind = frame.kind;
          unsubscribe?.();
          const sessionId = actorRef.sessionId;
          unsubscribe = listenForMentions(
            actorRef.participantId,
            kind,
            ({ message, trust }) => sendMention(ws, sessionId, message, trust),
          );
          await setConnectionStatus(db, { ...actorRef, kind, status: 'connected' });
          return;
        }

        if (frame.type !== 'status') return;
        if (
          frame.status !== 'working' &&
          frame.status !== 'idle' &&
          frame.status !== 'connected'
        ) {
          return;
        }
        await setConnectionStatus(db, { ...actorRef, kind, status: frame.status });
      } catch {
        // Ignore a malformed frame rather than dropping the connection.
      }
        };

    return {
      async onOpen(_evt, ws) {
        // Refusals travel in-band: a close code issued during the upgrade
        // arrives as 1006 with no reason (see docs/protocol.md).
        const refuse = (code: 'unauthenticated' | 'not_found') => {
          ws.send(JSON.stringify({ type: 'error', code }));
          ws.close();
        };

        if (!bearer) return refuse('unauthenticated');
        if (!ownerSlug || !sessionPublicId) return refuse('not_found');

        const actor = await resolveSessionToken(db, bearer);
        if (
          !actor ||
          actor.sessionPublicId !== sessionPublicId ||
          actor.ownerSlug !== ownerSlug
        ) {
          return refuse('not_found');
        }
        // A channel push starts a turn, so only an agent may hold a bridge.
        if (actor.participantKind !== 'agent') return refuse('not_found');

        actorRef = { sessionId: actor.sessionId, participantId: actor.participantId };

        ws.send(
          JSON.stringify({
            type: 'ready',
            participant: {
              id: actor.participantId,
              display_name: actor.participantName,
            },
            session: { id: actor.sessionPublicId, owner: actor.ownerSlug },
          }),
        );

        // Warm the repo cache now, so the first mention is delivered synchronously.
        void linkedRepos(db, actor.sessionId).catch(() => {});
        unsubscribe = listenForMentions(
          actor.participantId,
          kind,
          ({ message, trust }) => sendMention(ws, actor.sessionId, message, trust),
        );

        // A pause asks connections to drop in-flight work. Cooperative by
        // necessity: the process is on the user's machine (ADR 0012).
        unsubscribeAbort = onAbort(actor.sessionId, () => {
          ws.send(JSON.stringify({ type: 'abort' }));
        });

        await setConnectionStatus(db, {
          sessionId: actor.sessionId,
          participantId: actor.participantId,
          kind,
          status: 'connected',
        });
      },

      onMessage(evt, ws) {
        // A caught chain keeps a single bad frame from stalling every later one.
        queue = queue.then(() => handleFrame(evt, ws)).catch(() => {});
        return queue;
      },

      async onClose() {
        unsubscribe?.();
        unsubscribeAbort?.();
        if (actorRef) {
          await setConnectionStatus(db, { ...actorRef, kind, status: 'offline' }).catch(
            () => {},
          );
        }
      },
      onError() {
        unsubscribe?.();
        unsubscribeAbort?.();
      },
    };
  }),
);

/**
 * Mint a run-scoped token.
 *
 * Same session, same participant, short TTL, one run. A runner cannot mint a
 * token for anyone else — the participant comes from its own credential, never
 * from the request. See ADR 0011.
 */
app.post('/bridge/o/:owner/s/:session/run-token', async (c) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) {
    return c.json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="fabrikka"',
    });
  }

  const actor = await resolveSessionToken(db, bearer);
  if (
    !actor ||
    actor.sessionPublicId !== c.req.param('session') ||
    actor.ownerSlug !== c.req.param('owner') ||
    actor.participantKind !== 'agent'
  ) {
    return c.notFound();
  }

  const minted = await issueRunToken(db, {
    sessionId: actor.sessionId,
    participantId: actor.participantId,
    createdByUserId: actor.agent?.ownerUserId ?? '',
  });
  if (!minted) return c.notFound();

  return c.json(minted, 201);
});

/**
 * Revoke a run token when the run ends.
 *
 * A runner may only revoke tokens for its OWN participant, so possessing a
 * runner credential does not let you cut another agent's access.
 */
app.delete('/bridge/o/:owner/s/:session/run-token/:tokenId', async (c) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return c.json({ error: 'unauthorized' }, 401);

  const actor = await resolveSessionToken(db, bearer);
  if (
    !actor ||
    actor.sessionPublicId !== c.req.param('session') ||
    actor.ownerSlug !== c.req.param('owner')
  ) {
    return c.notFound();
  }

  const done = await revokeOwnToken(db, {
    sessionId: actor.sessionId,
    participantId: actor.participantId,
    tokenId: c.req.param('tokenId'),
  });
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/**
 * The MCP endpoint — lane A. Its own auth (participant-scoped bearer tokens),
 * so it is mounted outside the cookie-authenticated web API entirely.
 * See docs/protocol.md and ADR 0009.
 */
const mcp = createMcpApp({
  db,
  publicUrl: PUBLIC_URL,
  allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean),
});
app.route('/', mcp.app);

/*
 * IMPORTANT: this must be registered BEFORE app.route() mounts the session
 * sub-app below. That sub-app applies requireUser to everything under the
 * same prefix, so if it matched first an unauthenticated upgrade would get a
 * 401 HTTP response and never become a WebSocket at all — the client would
 * see an abnormal close with no reason and retry forever.
 */
/* -------------------------------------------------------------------------- */
/* Realtime                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Session event stream. Read-only: the browser posts over HTTP and receives the
 * resulting event back over this socket, so local echo and remote fan-out
 * follow the same path and cannot disagree.
 *
 * Authenticated by the same cookie as the REST API, and membership-checked —
 * a socket is not a way around the access rules.
 */
/**
 * The local host socket (M31, ADR 0027). Authenticated with the device token.
 * The host reports its grants (labels, never paths); the server answers with the
 * agents bound to it, each with a fresh token. The host then opens an ordinary
 * runner connection per binding — so nothing here starts a run by itself.
 */
app.get(
  '/host',
  upgradeWebSocket((c) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    let deviceId: string | null = null;
    let me: { send: (d: string) => void; close: () => void } | null = null;
    /** Bindings (and their fresh tokens) go out once per connection, not per grant change. */
    let bound = false;
    return {
      async onOpen(_evt, ws) {
        const device = await resolveDevice(db, bearer);
        if (!device) {
          ws.send(JSON.stringify({ type: 'error', code: 'unauthenticated' }));
          ws.close();
          return;
        }
        deviceId = device.id;
        me = { send: (d) => ws.send(d), close: () => ws.close() };
        hostHub.attach(device.id, me);
        ws.send(JSON.stringify({ type: 'ready', device: { id: device.id, name: device.name } }));
      },
      async onMessage(evt, ws) {
        if (!deviceId) return;
        let frame: { type?: string; grants?: { id: string; label: string; providers: string[] }[] };
        try {
          frame = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        if (frame.type === 'grants' && Array.isArray(frame.grants)) {
          await setGrants(db, deviceId, frame.grants);
          if (!bound) {
            bound = true;
            ws.send(JSON.stringify({ type: 'bindings', bindings: await bindingsForDevice(db, deviceId, PUBLIC_URL) }));
          }
        }
      },
      onClose() {
        if (deviceId && me) hostHub.detach(deviceId, me);
      },
      onError() {
        if (deviceId && me) hostHub.detach(deviceId, me);
      },
    };
  }),
);

app.get(
  '/api/o/:owner/s/:session/stream',
  upgradeWebSocket((c) => {
    const ownerSlug = c.req.param('owner');
    const sessionPublicId = c.req.param('session');
    const token = readCookie(c);
    let unsubscribe: (() => void) | undefined;

    return {
      async onOpen(_evt, ws) {
        /**
         * Refuse with an in-band frame, then close. A close code issued this
         * early does not reliably reach the client (it arrives as 1006), so the
         * reason travels as a normal message instead. See docs/protocol.md.
         */
        const refuse = (code: 'unauthenticated' | 'not_found') => {
          ws.send(JSON.stringify({ type: 'stream.error', code }));
          ws.close();
        };

        if (!ownerSlug || !sessionPublicId) return refuse('not_found');

        const user = await resolveToken(db, token);
        if (!user) return refuse('unauthenticated');

        // Viewers (M22) may listen: this socket only sends, so it gives them
        // nothing to write with.
        const s = await resolveSessionForViewer(
          db,
          ownerSlug,
          sessionPublicId,
          user.id,
        );
        // Same answer for "no such session" and "not a member".
        if (!s) return refuse('not_found');

        // Catch-up: a late joiner should see the run in progress, not just a
        // spinner and then an answer.
        const { runs: liveRuns, activity } = await catchUp(db, s.id);

        ws.send(
          JSON.stringify({
            type: 'hello',
            sessionId: s.view.publicId,
            participants: await listParticipants(db, s.id),
            runs: liveRuns,
            activity,
          }),
        );

        unsubscribe = subscribe(s.id, (event) => ws.send(JSON.stringify(event)));
      },
      onClose() {
        unsubscribe?.();
      },
      onError() {
        unsubscribe?.();
      },
    };
  }),
);


/**
 * Output sync socket (M12). The standard Yjs sync and awareness protocols, so
 * humans co-edit in real time. Same cookie, same membership check and the same
 * in-band refusal as the session stream. Agents never use it: their edits come
 * over MCP and are applied server-side (ADR 0019).
 */
app.get(
  '/api/o/:owner/s/:session/outputs/:output/sync',
  upgradeWebSocket((c) => {
    const ownerSlug = c.req.param('owner');
    const sessionPublicId = c.req.param('session');
    const outputId = c.req.param('output') ?? '';
    const token = readCookie(c);
    let handlers: Awaited<ReturnType<typeof attachSocket>> = null;
    let closed = false;
    // A client sends its first sync step the moment the socket opens, while we
    // are still checking who it is. Held, not dropped, or it never syncs.
    const early: (ArrayBuffer | string)[] = [];

    return {
      async onOpen(_evt, ws) {
        const refuse = (code: 'unauthenticated' | 'not_found') => {
          ws.send(JSON.stringify({ type: 'stream.error', code }));
          ws.close();
        };
        if (!ownerSlug || !sessionPublicId) return refuse('not_found');
        const user = await resolveToken(db, token);
        if (!user) return refuse('unauthenticated');
        const s = await resolveSessionForViewer(db, ownerSlug, sessionPublicId, user.id);
        if (!s) return refuse('not_found');

        handlers = await attachSocket(db, {
          sessionId: s.id,
          outputId,
          // A viewer (M22) syncs read-only: the store drops every update they send.
          participantId: s.participantId,
          readOnly: s.access === 'viewer',
          ws: {
            send: (data) => ws.send(data as never),
            close: () => ws.close(),
          },
        });
        if (!handlers) return refuse('not_found');
        for (const data of early.splice(0)) handlers.onMessage(data);
        // The socket may have closed while we were checking.
        if (closed) handlers.onClose();
      },
      onMessage(evt) {
        const data = evt.data as ArrayBuffer | string;
        if (handlers) handlers.onMessage(data);
        else if (early.length < 100) early.push(data);
      },
      onClose() {
        closed = true;
        handlers?.onClose();
      },
      onError() {
        closed = true;
        handlers?.onClose();
      },
    };
  }),
);

app.route('/api/o/:owner/s/:session', sessionRoutes);

/**
 * Setup instructions for one agent, generated per provider.
 *
 * Only the lanes that actually work for that provider are offered. Channels are
 * Claude Code-specific and stdio-only, and spawning only knows how to launch
 * `claude` and `codex` — so a Codex agent must not be shown a channel setup, and
 * an unknown provider gets the plain MCP endpoint and nothing else.
 * See docs/protocol.md.
 */
function agentSetup(mcpUrl: string, token: string, provider: string) {
  const bridgeMcpJson = JSON.stringify(
    {
      mcpServers: {
        fabrikka: {
          command: BRIDGE_COMMAND[0],
          args: [...BRIDGE_COMMAND.slice(1), 'connect'],
          env: { FABRIKKA_URL: mcpUrl, FABRIKKA_TOKEN: token },
        },
      },
    },
    null,
    2,
  );

  const runnerCommand =
    `FABRIKKA_URL=${mcpUrl} \\
  FABRIKKA_TOKEN=${token} \\
  ` +
    `${BRIDGE_COMMAND.join(' ')} watch --dir .` +
    (provider === 'codex' ? ' --provider codex' : '');

  // Phrased for the provider's own CLI. Codex takes the token from the
  // environment because it rejects a literal `bearer_token`, which conveniently
  // keeps it out of config.toml. An unknown provider gets the endpoint and header
  // rather than a command for a client it may not be: telling someone to run
  // `claude mcp add` for a Cursor agent is worse than telling them nothing.
  const remoteCommand =
    provider === 'codex'
      ? `FABRIKKA_TOKEN=${token} \\
  codex mcp add fabrikka --url ${mcpUrl} \\
    --bearer-token-env-var FABRIKKA_TOKEN`
      : provider === 'claude-code'
        ? `claude mcp add --transport http fabrikka ${mcpUrl} --header "Authorization: Bearer ${token}"`
        : `Streamable HTTP MCP endpoint:\n  ${mcpUrl}\n\nAuthorization: Bearer ${token}`;

  const lanes: SetupLane[] =
    provider === 'claude-code'
      ? ['bridge', 'runner', 'remote']
      : provider === 'codex'
        ? ['runner', 'remote']
        : ['remote'];

  return {
    token,
    mcpUrl,
    setup: {
      lanes,
      remoteCommand,
      bridgeMcpJson: lanes.includes('bridge') ? bridgeMcpJson : null,
      bridgeCommand: lanes.includes('bridge')
        ? 'claude --dangerously-load-development-channels server:fabrikka'
        : null,
      runnerCommand: lanes.includes('runner') ? runnerCommand : null,
    },
  };
}

/** Resolve the session addressed by the current route, for the current user. */
/**
 * Deliver a mention to a bridge or runner, with the session's linked repos so a
 * spawned run's preamble can name them (M19). Chained per socket: the repo
 * lookup is async, and two mentions must still arrive in the order they fired.
 */
const mentionQueues = new WeakMap<object, Promise<void>>();
function sendMention(ws: { send: (data: string) => void }, sessionId: string, message: unknown, trust: unknown) {
  const frame = (repos: { url: string; title: string | null }[]) =>
    JSON.stringify({ type: 'mention', message, trust, ...(repos.length ? { repos } : {}) });
  // The common case is synchronous: repos cached, nothing queued ahead of us.
  const cached = cachedRepos(sessionId);
  if (cached && !mentionQueues.has(ws)) {
    ws.send(frame(cached));
    return;
  }
  const prev = mentionQueues.get(ws) ?? Promise.resolve();
  const next = prev
    .then(async () => ws.send(frame(await linkedRepos(db, sessionId).catch(() => []))))
    .catch(() => {})
    .finally(() => {
      if (mentionQueues.get(ws) === next) mentionQueues.delete(ws);
    });
  mentionQueues.set(ws, next);
}

/** Members, each marked with whether their access came from the team roster (M21). */
async function membersWithOrigin(sessionId: string) {
  const origins = await membershipOrigins(db, sessionId);
  return (await listMembers(db, sessionId)).map((m) => ({ ...m, viaTeam: origins.has(m.userId) }));
}

/** The viewer-aware resolver (M22). Only allowlisted read routes may use it. */
async function resolveViewer(c: {
  req: { param: (k: string) => string | undefined };
  get: (k: 'user') => AuthEnv['Variables']['user'];
}) {
  const owner = c.req.param('owner');
  const session = c.req.param('session');
  if (!owner || !session) return null;
  return resolveSessionForViewer(db, owner, session, c.get('user').id);
}

async function resolve(c: {
  req: { param: (k: string) => string | undefined };
  get: (k: 'user') => AuthEnv['Variables']['user'];
}) {
  const owner = c.req.param('owner');
  const session = c.req.param('session');
  if (!owner || !session) return null;
  return resolveSessionForUser(db, owner, session, c.get('user').id);
}


/**
 * Serve the built web app, when there is one.
 *
 * In development Vite serves the UI on :5173 and proxies /api here, so this does
 * nothing. In production — and for the desktop shell, which points at a single
 * URL — the server has to serve both, or the app is an API with no interface.
 *
 * Registered last so it never shadows /api, /mcp or /bridge.
 */
const WEB_DIST = resolvePath(import.meta.dirname, '../../web/dist');

if (existsSync(WEB_DIST)) {
  app.use('/assets/*', serveStatic({ root: relative(process.cwd(), WEB_DIST) }));

  // SPA fallback: every non-API path returns index.html so client-side routes
  // like /o/fede/s/demo work on a hard refresh.
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/mcp')) {
      return c.notFound();
    }
    const html = await readFile(resolvePath(WEB_DIST, 'index.html'), 'utf8');
    return c.html(html);
  });

  console.log(`serving the web app from ${WEB_DIST}`);
} else {
  console.log('no web build found — run `pnpm --filter @fabrikka/web build` to serve the UI');
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`fabrikka server on http://localhost:${info.port}`);
});

injectWebSocket(server);

