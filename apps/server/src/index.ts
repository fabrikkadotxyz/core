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
  listSessionsForUser,
  removeMember,
  renameSession,
  resolveSessionForUser,
  setSessionStatus,
} from './sessions.ts';

const PORT = Number(process.env.PORT ?? 9090);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');

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

  const view: SessionView = {
    session: s.view,
    participants: await listParticipants(db, s.id),
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
  const message = await createMessage(db, s.id, s.participantId, content);
  publish(s.id, { type: 'message.created', message });

  return c.json(message, 201);
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

