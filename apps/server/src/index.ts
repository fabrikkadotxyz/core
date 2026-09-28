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
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@fabrikka/db';
import type {
  LoginBody,
  PostMessageBody,
  RenameParticipantBody,
  SessionContext,
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
  setAgentTrustTier,
} from './agents.ts';
import {
  createInvite,
  describeInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
} from './invites.ts';
import { createUser } from './users.ts';
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
  setSessionStatus,
  updateSessionContext,
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

  return c.json({
    user: created.user,
    session: { ownerSlug: redeemed.ownerSlug, publicId: redeemed.sessionPublicId },
  }, 201);
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
  return c.json({
    session: { ownerSlug: result.ownerSlug, publicId: result.sessionPublicId },
  });
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

app.get('/api/sessions', requireUser(db), async (c) =>
  c.json(await listSessionsForUser(db, c.get('user').id)),
);

app.post('/api/sessions', requireUser(db), async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  const trimmed = title?.trim();
  if (!trimmed) return c.json({ error: 'title is required' }, 400);

  return c.json(await createSession(db, c.get('user'), trimmed), 201);
});

const sessionRoutes = new Hono<AuthEnv>();

sessionRoutes.use('*', requireUser(db));

sessionRoutes.get('/', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const statuses = await connectionStatuses(db, s.id);
  const view: SessionView = {
    session: s.view,
    participants: (await listParticipants(db, s.id)).map((p) => ({
      ...p,
      status: statuses.get(p.id),
    })),
    members: await listMembers(db, s.id),
    me: { role: s.role, participantId: s.participantId },
    mcpEndpoint: `${PUBLIC_URL}/mcp/o/${s.view.ownerSlug}/s/${s.view.publicId}`,
  };
  return c.json(view);
});

sessionRoutes.patch('/', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  // Only owners mutate the session itself. A member gets 404 rather than 403:
  // from their perspective the mutable resource does not exist.
  if (s.role !== 'owner') return c.notFound();

  const body = await c.req.json<{ title?: string; status?: 'active' | 'archived' }>();

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
  const s = await resolve(c);
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
  // Mentions of agents are evaluated and pushed here, not in the bridge.
  await deliverMentions(db, s.id, result.message);

  return c.json(result.message, 201);
});

/* ---- participants ---- */

sessionRoutes.get('/participants', async (c) => {
  const s = await resolve(c);
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
  return c.json(await listMembers(db, s.id));
});

sessionRoutes.delete('/members/:userId', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();

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
  if (!s || s.role !== 'owner') return c.notFound();

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

  return c.json({ ...agentSetup(mcpUrl, token), agent }, 201);
});

sessionRoutes.patch('/agents/:sessionAgentId/trust', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();

  const { trustTier } = await c.req.json<{ trustTier?: string }>();
  if (trustTier !== 'owner_only' && trustTier !== 'session_trusted') {
    return c.json({ error: 'trustTier must be owner_only or session_trusted' }, 400);
  }

  const done = await setAgentTrustTier(db, s.id, c.req.param('sessionAgentId'), trustTier);
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
  return c.json(agentSetup(mcpUrl, token), 201);
});

sessionRoutes.post('/tokens/:id/revoke', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  const done = await revokeToken(db, s.id, c.req.param('id'));
  if (!done) return c.notFound();
  return c.json({ ok: true });
});

/* ---- context ---- */

sessionRoutes.get('/context', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();
  return c.json(await getSessionContext(db, s.id));
});

sessionRoutes.patch('/context', async (c) => {
  const s = await resolve(c);
  if (!s) return c.notFound();

  const body = await c.req.json<Partial<SessionContext>>();
  const updated = await updateSessionContext(db, s.id, body);
  publish(s.id, { type: 'context.updated', context: updated });
  return c.json(updated);
});

/* ---- invites ---- */

sessionRoutes.get('/invites', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();
  return c.json(await listInvites(db, s.id));
});

/**
 * Creating an invite returns the plaintext token exactly once. The UI copies
 * `url` to the clipboard; delivery is out of band, by design (ADR 0007).
 */
sessionRoutes.post('/invites', async (c) => {
  const s = await resolve(c);
  if (!s || s.role !== 'owner') return c.notFound();

  type InviteBody = {
    invitedEmail?: string;
    role?: 'owner' | 'member';
    ttlDays?: number;
  };
  // An empty body is valid: it means "a default member invite".
  const body: InviteBody = await c.req.json<InviteBody>().catch(() => ({}));

  const { summary, token } = await createInvite(db, {
    sessionId: s.id,
    createdByUserId: c.get('user').id,
    role: body.role === 'owner' ? 'owner' : 'member',
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

  const revoked = await revokeInvite(db, s.id, c.req.param('id'));
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
    let actorRef: { sessionId: string; participantId: string } | undefined;
    /**
     * `bridge` pushes into a live agent session; `runner` spawns a headless run.
     * Defaults to bridge so an older client keeps working, and is re-registered
     * when a `hello` frame declares otherwise.
     */
    let kind: 'bridge' | 'runner' = 'bridge';

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

        unsubscribe = listenForMentions(
          actor.participantId,
          kind,
          ({ message, trust }) => {
            ws.send(JSON.stringify({ type: 'mention', message, trust }));
          },
        );

        await setConnectionStatus(db, {
          sessionId: actor.sessionId,
          participantId: actor.participantId,
          kind,
          status: 'connected',
        });
      },

      async onMessage(evt, ws) {
        if (!actorRef) return;
        try {
          const frame = JSON.parse(String(evt.data)) as {
            type?: string;
            status?: string;
            kind?: string;
          };

          // Declaring `runner` re-registers the listener under that kind, so a
          // live bridge elsewhere still wins the mention (ADR 0011).
          if (frame.type === 'hello') {
            if (frame.kind !== 'runner' && frame.kind !== 'bridge') return;
            if (frame.kind === kind) return;

            kind = frame.kind;
            unsubscribe?.();
            unsubscribe = listenForMentions(
              actorRef.participantId,
              kind,
              ({ message, trust }) => {
                ws.send(JSON.stringify({ type: 'mention', message, trust }));
              },
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
      },

      async onClose() {
        unsubscribe?.();
        if (actorRef) {
          await setConnectionStatus(db, { ...actorRef, kind, status: 'offline' }).catch(
            () => {},
          );
        }
      },
      onError() {
        unsubscribe?.();
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

        const s = await resolveSessionForUser(
          db,
          ownerSlug,
          sessionPublicId,
          user.id,
        );
        // Same answer for "no such session" and "not a member".
        if (!s) return refuse('not_found');

        ws.send(
          JSON.stringify({
            type: 'hello',
            sessionId: s.view.publicId,
            participants: await listParticipants(db, s.id),
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


app.route('/api/o/:owner/s/:session', sessionRoutes);

/**
 * Both ways to connect an agent, generated with the token already in place.
 *
 * Lane A is pull-only and works with any MCP client. Lane B adds real-time push
 * into a running Claude Code session, which needs a local process and a
 * research-preview flag. See docs/protocol.md.
 */
function agentSetup(mcpUrl: string, token: string) {
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

  return {
    token,
    mcpUrl,
    // Lane A: any MCP client, pull only.
    claudeCommand: `claude mcp add --transport http fabrikka ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    // Lane B: real-time push. The .mcp.json goes in the project directory, then
    // Claude Code is started with the channel opted in.
    bridgeMcpJson,
    bridgeCommand: 'claude --dangerously-load-development-channels server:fabrikka',
    // Lane B, unattended: spawn a headless run per mention (ADR 0011). The env
    // vars are inline because this is a shell command, not a config file.
    runnerCommand:
      `FABRIKKA_URL=${mcpUrl} \\
  FABRIKKA_TOKEN=${token} \\
  ` +
      `${BRIDGE_COMMAND.join(' ')} watch --dir .`,
  };
}

/** Resolve the session addressed by the current route, for the current user. */
async function resolve(c: {
  req: { param: (k: string) => string | undefined };
  get: (k: 'user') => AuthEnv['Variables']['user'];
}) {
  const owner = c.req.param('owner');
  const session = c.req.param('session');
  if (!owner || !session) return null;
  return resolveSessionForUser(db, owner, session, c.get('user').id);
}


const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`fabrikka server on http://localhost:${info.port}`);
});

injectWebSocket(server);

