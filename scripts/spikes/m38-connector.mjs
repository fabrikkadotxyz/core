/**
 * M38 spike: can Claude and ChatGPT add Fabrikka as a remote MCP connector?
 *
 * docs/mvp.md, Phase 2, "Verify before building". This is NOT the milestone. It
 * stands in for Fabrikka with fake rooms, so the owner can check in one sitting
 * whether each chat app:
 *   - discovers the OAuth metadata (RFC 9728 and RFC 8414);
 *   - registers itself (RFC 7591, dynamic client registration);
 *   - completes sign-in with PKCE (S256) through a consent page;
 *   - lists the tools, calls one, and shows the result.
 * Everything is in memory and fake. The console log IS the result of the check.
 *
 * ── How to run it ──────────────────────────────────────────────────────────
 *
 * 1. Start it (from the repo root, after `pnpm install`):
 *      node scripts/spikes/m38-connector.mjs
 *
 * 2. Expose it over HTTPS. claude.ai and ChatGPT connect from THEIR servers, so
 *    they can't reach localhost. A quick tunnel needs no account:
 *      cloudflared tunnel --url http://localhost:8787
 *    (or: ngrok http 8787). It prints a URL like https://abc-def.trycloudflare.com
 *
 * 3. Restart the spike with that URL, so the metadata names it:
 *      PUBLIC_BASE_URL=https://abc-def.trycloudflare.com node scripts/spikes/m38-connector.mjs
 *
 * 4. Add <tunnel URL>/mcp as a connector:
 *    - claude.ai: Settings → Connectors → Add custom connector → paste the URL →
 *      Add → Connect (a consent page opens: Allow).
 *    - Claude Desktop: the same, in Settings → Connectors.
 *    - ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode on →
 *      Create → the URL, OAuth → Allow.
 *    Then, in a chat: "List my Fabrikka rooms", "What did we decide in the
 *    checkout room?", "Post 'on it' in the checkout room".
 *
 * 5. What to look for, here in the console and in the chat app:
 *    - [register] a line with the client's name and redirect_uri;
 *    - [authorize] the scope and resource it asks for, then [allow];
 *    - [token] a code exchanged with PKCE, and later refreshes;
 *    - [mcp] initialize, tools/list, then tools/call with its arguments;
 *    - how the chat app renders the tool result, and whether it asks before
 *      calling post_message (a write).
 *    Note which plan each account is on (custom connectors aren't on every
 *    plan), and anything that failed, with the last log lines.
 *
 * Env: PORT (default 8787), PUBLIC_BASE_URL (default http://localhost:PORT).
 * Stop it with Ctrl-C. Nothing it holds survives a restart.
 */
import { createHash, randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const PORT = Number(process.env.PORT ?? 8787);
const BASE = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const RESOURCE = `${BASE}/mcp`;
const ACCESS_TTL_S = 15 * 60;
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const rand = (n = 32) => randomBytes(n).toString('base64url');
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const log = (tag, msg) => console.log(`${new Date().toISOString().slice(11, 19)} [${tag}] ${msg}`);

/* ------------------------------------------------------------ in-memory state */

const clients = new Map(); // client_id -> { client_name, redirect_uris, client_secret? }
const pending = new Map(); // request id -> authorize params, until Allow
const codes = new Map(); // code -> { client_id, redirect_uri, challenge, scope, resource, exp }
const tokens = new Map(); // access token -> { client_id, scope, exp }
const refreshes = new Map(); // refresh token -> { client_id, scope }

const rooms = {
  checkout: {
    title: 'Checkout 500s',
    messages: [
      { from: 'Fede', text: 'Checkout is throwing 500s since the 14:00 deploy.' },
      { from: 'claude-fede', text: 'Sentry shows a null currency on EU carts. It started with PR #812.' },
      { from: 'Alice', text: 'Rolling back #812 for now.' },
    ],
    decisions: ['Roll back PR #812 until the currency fix lands.'],
    open: ['Do EU carts created during the incident need a refund?'],
  },
  paper: {
    title: 'Group paper: urban heat islands',
    messages: [
      { from: 'Sofía', text: 'Draft of section 2 is in the outputs.' },
      { from: 'Prof. Rojas', text: 'Section 2 needs a source for the 3 °C figure.' },
    ],
    decisions: ['Use the 2019–2024 satellite data only.'],
    open: ['Who presents on Friday?'],
  },
};

const TOOLS = [
  {
    name: 'list_rooms',
    description: 'List the Fabrikka rooms you are in, with their titles.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_room',
    description: "Read a room: its latest messages, the decisions made, and the questions still open. Use it before answering anything about the room's work.",
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string', description: 'The room id, from list_rooms (for example "checkout").' } },
      required: ['room'],
      additionalProperties: false,
    },
  },
  {
    name: 'post_message',
    description: 'Post a message in a room, as you. Everyone in the room sees it.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'The room id, from list_rooms.' },
        text: { type: 'string', description: 'The message to post.' },
      },
      required: ['room', 'text'],
      additionalProperties: false,
    },
  },
];

function callTool(name, args) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  if (name === 'list_rooms') {
    return text(Object.entries(rooms).map(([id, r]) => `${id}: ${r.title}`).join('\n'));
  }
  const room = rooms[args?.room];
  if (!room) return fail(`There's no room "${args?.room}". Call list_rooms for the ids.`);
  if (name === 'read_room') {
    return text(
      [
        `# ${room.title}`,
        '',
        '## Latest messages',
        ...room.messages.map((m) => `- ${m.from}: ${m.text}`),
        '',
        '## Decisions',
        ...room.decisions.map((d) => `- ${d}`),
        '',
        '## Open questions',
        ...room.open.map((q) => `- ${q}`),
      ].join('\n'),
    );
  }
  if (name === 'post_message') {
    const msg = String(args?.text ?? '').trim();
    if (!msg) return fail('The message is empty.');
    room.messages.push({ from: 'connector', text: msg });
    log('room', `POSTED in "${args.room}": ${msg}`);
    return text(`Posted in ${room.title}.`);
  }
  return fail(`Unknown tool ${name}`);
}

/* ------------------------------------------------------------ the app */

const app = new Hono();

app.use('*', async (c, next) => {
  log('http', `${c.req.method} ${c.req.path}`);
  await next();
});

const allowCors = (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
  c.header('Access-Control-Expose-Headers', 'www-authenticate, mcp-session-id');
};
app.options('*', (c) => {
  allowCors(c);
  c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  return c.body(null, 204);
});

/* ---- discovery */

const protectedResource = (c) => {
  allowCors(c);
  return c.json({
    resource: RESOURCE,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
    scopes_supported: ['rooms'],
    resource_name: 'Fabrikka (M38 spike)',
  });
};
app.get('/.well-known/oauth-protected-resource', protectedResource);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

const authServer = (c) => {
  allowCors(c);
  return c.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/authorize`,
    token_endpoint: `${BASE}/token`,
    registration_endpoint: `${BASE}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['rooms'],
  });
};
app.get('/.well-known/oauth-authorization-server', authServer);
// Some clients try the RFC 8414 path with the resource's path appended, or OIDC's.
app.get('/.well-known/oauth-authorization-server/mcp', authServer);
app.get('/.well-known/openid-configuration', authServer);

/* ---- RFC 7591: dynamic client registration */

const okRedirect = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

app.post('/register', async (c) => {
  allowCors(c);
  const body = await c.req.json().catch(() => ({}));
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || !uris.every(okRedirect)) {
    log('register', `REFUSED redirect_uris=${JSON.stringify(uris)}`);
    return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or localhost)' }, 400);
  }
  const method = body.token_endpoint_auth_method ?? 'none';
  const client = {
    client_id: `mc_${rand(12)}`,
    client_name: body.client_name ?? '(no name)',
    redirect_uris: uris,
    token_endpoint_auth_method: method === 'client_secret_post' ? 'client_secret_post' : 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  if (client.token_endpoint_auth_method === 'client_secret_post') client.client_secret = rand(24);
  clients.set(client.client_id, client);
  log(
    'register',
    `client_name="${client.client_name}" redirect_uris=${JSON.stringify(uris)} auth=${client.token_endpoint_auth_method} ` +
      `asked: grant_types=${JSON.stringify(body.grant_types)} scope=${JSON.stringify(body.scope)}`,
  );
  return c.json(client, 201);
});

/* ---- authorize: a consent page, then a code */

app.get('/authorize', (c) => {
  const q = c.req.query();
  const client = clients.get(q.client_id);
  log(
    'authorize',
    `client="${client?.client_name ?? q.client_id}" redirect_uri=${q.redirect_uri} scope=${JSON.stringify(q.scope ?? null)} ` +
      `resource=${JSON.stringify(q.resource ?? null)} method=${q.code_challenge_method} state=${q.state ? 'yes' : 'NO'}`,
  );
  if (!client) return c.text('unknown client_id: register first', 400);
  if (!client.redirect_uris.includes(q.redirect_uri)) return c.text('redirect_uri was not registered', 400);
  if (q.response_type !== 'code') return c.text('response_type must be code', 400);
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return c.text('PKCE with S256 is required', 400);

  const id = rand(16);
  pending.set(id, { ...q, client_name: client.client_name });
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Fabrikka</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f4fafc;color:#293241}
  main{width:min(420px,92vw);padding:28px;border-radius:18px;background:#fff;box-shadow:0 18px 40px -18px rgba(61,90,128,.45)}
  button{width:100%;min-height:44px;border:0;border-radius:12px;color:#fff;font:inherit;font-weight:600;cursor:pointer;
    background:linear-gradient(120deg,#2f4a6e,#3d5a80 45%,#5a7fa8)}
  p{color:#5d6d82;line-height:1.5}
</style></head><body><main>
<h1>Connect to Fabrikka</h1>
<p>Allow <strong>${esc(client.client_name)}</strong> to read your Fabrikka rooms and post in them as you?</p>
<p style="font-size:.85rem">This is the M38 spike: the rooms are fake.</p>
<form method="post" action="/authorize"><input type="hidden" name="id" value="${esc(id)}">
<button type="submit">Allow</button></form>
</main></body></html>`);
});

app.post('/authorize', async (c) => {
  const form = await c.req.parseBody();
  const req = pending.get(String(form.id ?? ''));
  if (!req) return c.text('this consent page has expired; start again from the app', 400);
  pending.delete(String(form.id));
  const code = rand();
  codes.set(code, {
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    challenge: req.code_challenge,
    scope: req.scope ?? 'rooms',
    resource: req.resource ?? null,
    exp: Date.now() + 5 * 60 * 1000,
  });
  const to = new URL(req.redirect_uri);
  to.searchParams.set('code', code);
  if (req.state) to.searchParams.set('state', req.state);
  log('allow', `client="${req.client_name}" → redirecting with a code to ${to.origin}${to.pathname}`);
  return c.redirect(to.href, 302);
});

/* ---- token: PKCE code exchange, and refresh */

function issue(client_id, scope) {
  const access = rand();
  const refresh = rand();
  tokens.set(access, { client_id, scope, exp: Date.now() + ACCESS_TTL_S * 1000 });
  refreshes.set(refresh, { client_id, scope });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

app.post('/token', async (c) => {
  allowCors(c);
  const type = c.req.header('content-type') ?? '';
  const body = type.includes('application/json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody();
  const err = (error, description, status = 400) => {
    log('token', `REFUSED ${body.grant_type}: ${error} (${description})`);
    return c.json({ error, error_description: description }, status);
  };
  const client = clients.get(body.client_id);
  if (!client) return err('invalid_client', 'unknown client_id', 401);
  if (client.token_endpoint_auth_method === 'client_secret_post' && body.client_secret !== client.client_secret) {
    return err('invalid_client', 'wrong client_secret', 401);
  }

  if (body.grant_type === 'authorization_code') {
    const entry = codes.get(body.code);
    codes.delete(body.code); // single use, even when it fails
    if (!entry || entry.exp < Date.now() || entry.client_id !== client.client_id) return err('invalid_grant', 'code unknown, used, expired or not yours');
    if (entry.redirect_uri !== body.redirect_uri) return err('invalid_grant', 'redirect_uri does not match');
    if (!body.code_verifier || s256(body.code_verifier) !== entry.challenge) return err('invalid_grant', 'PKCE verifier does not match');
    log('token', `client="${client.client_name}" code exchanged with PKCE; resource at token=${JSON.stringify(body.resource ?? null)} (authorize said ${JSON.stringify(entry.resource)})`);
    return c.json(issue(client.client_id, entry.scope));
  }

  if (body.grant_type === 'refresh_token') {
    const entry = refreshes.get(body.refresh_token);
    if (!entry || entry.client_id !== client.client_id) return err('invalid_grant', 'refresh token unknown or not yours');
    refreshes.delete(body.refresh_token); // rotate
    log('token', `client="${client.client_name}" refreshed`);
    return c.json(issue(client.client_id, entry.scope));
  }

  return err('unsupported_grant_type', String(body.grant_type));
});

/* ---- the MCP endpoint: streamable HTTP, JSON responses */

function bearer(c) {
  const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const entry = token && tokens.get(token);
  return entry && entry.exp > Date.now() ? { token, ...entry } : null;
}

const unauthorized = (c) => {
  allowCors(c);
  c.header('WWW-Authenticate', `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  return c.json({ error: 'unauthorized' }, 401);
};

async function handle(msg, who) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    const version = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
    log('mcp', `initialize from ${JSON.stringify(params?.clientInfo ?? null)} protocol asked=${asked} answered=${version}`);
    return reply({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fabrikka-m38-spike', version: '0.0.1' },
      instructions: 'Fabrikka rooms: read a room before answering about its work; post only when the person asks you to.',
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    log('mcp', `${method}`);
    return null;
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') {
    log('mcp', `tools/list by "${who}"`);
    return reply({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    log('mcp', `tools/call ${params?.name} ${JSON.stringify(params?.arguments ?? {})} by "${who}"`);
    return reply(callTool(params?.name, params?.arguments ?? {}));
  }
  if (id === undefined) return null; // an unknown notification
  log('mcp', `unsupported method ${method}`);
  return error(-32601, `Method not found: ${method}`);
}

app.post('/mcp', async (c) => {
  const auth = bearer(c);
  if (!auth) {
    log('mcp', `401: ${c.req.header('authorization') ? 'invalid or expired token' : 'no token'}`);
    return unauthorized(c);
  }
  allowCors(c);
  const who = clients.get(auth.client_id)?.client_name ?? auth.client_id;
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const msg of batch) {
    const r = await handle(msg, who);
    if (r) out.push(r);
  }
  if (!out.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? out : out[0]);
});

// No server-initiated stream in this spike: say so the way the spec allows.
app.get('/mcp', (c) => (bearer(c) ? c.body(null, 405) : unauthorized(c)));
app.delete('/mcp', (c) => (bearer(c) ? c.body(null, 200) : unauthorized(c)));

app.get('/', (c) => c.text(`Fabrikka M38 spike. Add ${RESOURCE} as a connector.\n`));

serve({ fetch: app.fetch, port: PORT }, () => {
  log('start', `listening on :${PORT}; base ${BASE}; connector URL: ${RESOURCE}`);
  if (BASE.startsWith('http://localhost')) {
    log('start', 'claude.ai and ChatGPT can\'t reach localhost: tunnel it, then restart with PUBLIC_BASE_URL (see the header).');
  }
});

