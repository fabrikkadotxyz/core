/**
 * Fabrikka server — M0.
 *
 * Routes are owner-scoped to mirror the MCP endpoint path exactly, so the web
 * API and the agent-facing contract cannot drift apart. See docs/protocol.md.
 */
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@fabrikka/db';
import type { PostMessageBody, SessionView } from '@fabrikka/types';
import { publish, subscribe } from './bus.ts';
import {
  createMessage,
  listMessages,
  listParticipants,
  participantInSession,
  resolveSession,
} from './sessions.ts';

const PORT = Number(process.env.PORT ?? 9090);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

const { db } = createClient();

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// M0 only: the web dev server runs on a different origin. M1 narrows this.
app.use('/api/*', cors({ origin: ['http://localhost:5173'] }));

app.get('/health', (c) => c.json({ ok: true }));

/**
 * The owner-scoped session route. A wrong owner slug and a non-existent session
 * are the same 404 — existence is private (docs/security.md).
 */
app.get('/api/o/:owner/s/:session', async (c) => {
  const resolved = await resolveSession(
    db,
    c.req.param('owner'),
    c.req.param('session'),
  );
  if (!resolved) return c.notFound();

  const view: SessionView = {
    session: resolved.view,
    participants: await listParticipants(db, resolved.id),
    mcpEndpoint: `${PUBLIC_URL}/mcp/o/${resolved.view.ownerSlug}/s/${resolved.view.publicId}`,
  };
  return c.json(view);
});

app.get('/api/o/:owner/s/:session/messages', async (c) => {
  const resolved = await resolveSession(
    db,
    c.req.param('owner'),
    c.req.param('session'),
  );
  if (!resolved) return c.notFound();

  return c.json(await listMessages(db, resolved.id));
});

/**
 * M0 takes the author as a query param because auth arrives at M1. It is still
 * validated against the session, so it cannot be used to post into a session
 * the participant isn't in.
 */
app.post('/api/o/:owner/s/:session/messages', async (c) => {
  const resolved = await resolveSession(
    db,
    c.req.param('owner'),
    c.req.param('session'),
  );
  if (!resolved) return c.notFound();

  const authorId = c.req.query('as');
  if (!authorId) {
    return c.json({ error: 'missing ?as=<participant_id>' }, 400);
  }
  if (!(await participantInSession(db, resolved.id, authorId))) {
    return c.notFound();
  }

  const body = await c.req.json<PostMessageBody>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content is required' }, 400);

  const message = await createMessage(db, resolved.id, authorId, content);
  publish(resolved.id, { type: 'message.created', message });

  return c.json(message, 201);
});

/**
 * Session event stream. Read-only in M0: the browser posts over HTTP and
 * receives the resulting event back over this socket, so the local echo and
 * the remote fan-out follow the same path and can't disagree.
 */
app.get(
  '/api/o/:owner/s/:session/stream',
  upgradeWebSocket((c) => {
    const ownerSlug = c.req.param('owner');
    const sessionPublicId = c.req.param('session');
    let unsubscribe: (() => void) | undefined;

    return {
      async onOpen(_evt, ws) {
        // The upgrade context isn't route-typed, so params are optional here.
        if (!ownerSlug || !sessionPublicId) {
          ws.close(4004, 'not found');
          return;
        }

        const resolved = await resolveSession(db, ownerSlug, sessionPublicId);
        if (!resolved) {
          ws.close(4004, 'not found');
          return;
        }

        ws.send(
          JSON.stringify({
            type: 'hello',
            sessionId: resolved.view.publicId,
            participants: await listParticipants(db, resolved.id),
          }),
        );

        unsubscribe = subscribe(resolved.id, (event) => {
          ws.send(JSON.stringify(event));
        });
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

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`fabrikka server on http://localhost:${info.port}`);
});

injectWebSocket(server);
