/**
 * M18 fixture: a fake vendor — an OAuth 2.1 authorization server and the MCP
 * server it protects — shaped like the real first-wave ones (probed 2026-10-07):
 * RFC 9728 resource metadata in the 401, RFC 8414 metadata, PKCE (S256), and
 * dynamic registration, or none (GitHub-like) with --no-registration.
 *
 *   node fake-oauth-mcp.mjs <port> [--no-registration --client <id>:<secret>]
 *
 * It enforces what a real vendor does — the registered redirect URI, PKCE,
 * single-use codes, rotating refresh tokens — so the acceptance check proves
 * Fabrikka's side rather than a mock's leniency. Test-only controls live under
 * /admin. Consent is automatic: /oauth/authorize redirects straight back.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';

const PORT = Number(process.argv[2] ?? 9201);
const NO_REG = process.argv.includes('--no-registration');
// Like GitLab (no public clients at the token endpoint) and ClickUp (no refresh
// grant): the metadata says so, registration refuses anything else, and the
// registered client gets a secret it must present.
const CONFIDENTIAL = process.argv.includes('--confidential');
const PRE = process.argv[process.argv.indexOf('--client') + 1]?.split(':');
// Like Google: the MCP server answers without a challenge, the authorization
// server has only an OpenID configuration, and a refresh token comes only with
// access_type=offline and prompt=consent (ADR 0046).
const GOOGLE_LIKE = process.argv.includes('--google-like');
const BASE = `http://localhost:${PORT}`;
const ISSUER = `${BASE}/oauth`;

const clients = new Map(); // client_id -> { secret, redirectUris }
if (PRE) clients.set(PRE[0], { secret: PRE[1], redirectUris: null }); // pre-registered: any redirect on localhost
const codes = new Map(); // code -> { clientId, redirectUri, challenge, resource }
const access = new Map(); // token -> { expiresAt }
const refreshes = new Map(); // token -> { clientId, revoked }
const stats = { registrations: 0, codes: 0, refreshes: 0, offline: 0 };
let ttl = 3600;

const token = () => randomBytes(24).toString('base64url');
const b64sha = (s) => createHash('sha256').update(s).digest('base64url');

const app = createMcpHonoApp();

/* ---- discovery ---- */
app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json({ resource: `${BASE}/mcp`, authorization_servers: [ISSUER] }));
app.get('/.well-known/oauth-authorization-server/oauth', (c, next) => (GOOGLE_LIKE ? next() : c.json(metadata())));
app.get('/.well-known/openid-configuration', (c) => (GOOGLE_LIKE ? c.json(metadata()) : c.notFound()));
app.get('/oauth/.well-known/openid-configuration', (c) => (GOOGLE_LIKE ? c.json(metadata()) : c.notFound()));
const metadata = () => ({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    ...(NO_REG ? {} : { registration_endpoint: `${ISSUER}/register` }),
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: CONFIDENTIAL ? ['authorization_code'] : ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: CONFIDENTIAL ? ['client_secret_post'] : ['none'],
});

/* ---- registration (RFC 7591) ---- */
app.post('/oauth/register', async (c) => {
  if (NO_REG) return c.json({ error: 'registration_not_supported' }, 404);
  const body = await c.req.json();
  if (CONFIDENTIAL) {
    if ((body.grant_types ?? []).includes('refresh_token')) return c.json({ error: 'invalid_client_metadata', error_description: 'no refresh_token grant here' }, 400);
    if (body.token_endpoint_auth_method !== 'client_secret_post') return c.json({ error: 'invalid_client_metadata', error_description: 'public clients not allowed' }, 400);
  }
  const id = `client-${token()}`;
  const secret = CONFIDENTIAL ? `secret-${token()}` : null;
  clients.set(id, { secret, redirectUris: body.redirect_uris ?? [] });
  stats.registrations++;
  return c.json({ client_id: id, redirect_uris: body.redirect_uris, ...(secret ? { client_secret: secret } : {}) }, 201);
});

/* ---- authorize: automatic consent ---- */
app.get('/oauth/authorize', (c) => {
  if (GOOGLE_LIKE) {
    if (c.req.query('access_type') !== 'offline' || c.req.query('prompt') !== 'consent') return c.text('a refresh token needs access_type=offline and prompt=consent', 400);
    stats.offline++;
  }
  const q = c.req.query();
  const client = clients.get(q.client_id);
  const redirectOk = client && (client.redirectUris === null ? q.redirect_uri?.startsWith('http://localhost') : client.redirectUris.includes(q.redirect_uri));
  if (!redirectOk) return c.text('unknown client or redirect_uri', 400);
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) return c.text('PKCE S256 required', 400);
  const code = token();
  codes.set(code, { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, resource: q.resource });
  stats.codes++;
  const back = new URL(q.redirect_uri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', q.state);
  return c.redirect(back.href);
});

/* ---- token ---- */
app.post('/oauth/token', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const client = clients.get(form.get('client_id'));
  if (!client) return c.json({ error: 'invalid_client' }, 401);
  if (client.secret && form.get('client_secret') !== client.secret) return c.json({ error: 'invalid_client' }, 401);
  const issue = () => {
    const a = token();
    const r = token();
    access.set(a, { expiresAt: Date.now() + ttl * 1000 });
    refreshes.set(r, { clientId: form.get('client_id'), revoked: false });
    return CONFIDENTIAL ? { access_token: a, token_type: 'Bearer', expires_in: ttl } : { access_token: a, token_type: 'Bearer', expires_in: ttl, refresh_token: r };
  };
  if (form.get('grant_type') === 'authorization_code') {
    const code = codes.get(form.get('code'));
    codes.delete(form.get('code')); // single use
    if (!code || code.clientId !== form.get('client_id') || code.redirectUri !== form.get('redirect_uri')) return c.json({ error: 'invalid_grant' }, 400);
    if (b64sha(form.get('code_verifier') ?? '') !== code.challenge) return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    return c.json(issue());
  }
  if (form.get('grant_type') === 'refresh_token') {
    const r = refreshes.get(form.get('refresh_token'));
    if (!r || r.revoked || r.clientId !== form.get('client_id')) return c.json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400);
    r.revoked = true; // rotating: the old one is spent
    stats.refreshes++;
    return c.json(issue());
  }
  return c.json({ error: 'unsupported_grant_type' }, 400);
});

/* ---- test-only controls ---- */
app.post('/admin/ttl/:seconds', (c) => ((ttl = Number(c.req.param('seconds'))), c.json({ ttl })));
app.post('/admin/revoke-refresh', (c) => {
  for (const r of refreshes.values()) r.revoked = true;
  return c.json({ ok: true });
});
app.get('/admin/stats', (c) => c.json({ ...stats, clients: clients.size }));

/* ---- the protected MCP server ---- */
const handler = createMcpHandler((ctx) => {
  const server = new McpServer({ name: 'fake-vendor', version: '0.0.1' });
  const seen = { token: ctx.authInfo?.token, stack: ctx.authInfo?.extra?.stack ?? null };
  server.registerTool('whoami', { description: 'Which token and stack reached the vendor.', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(seen) }],
  }));
  server.registerTool('list_issues', { description: 'List issues (read).', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ issues: ['#1'], ...seen }) }],
  }));
  server.registerTool('merge_pull_request', { description: 'Merge a PR (write).', inputSchema: z.object({ number: z.number() }) }, async (a) => ({
    content: [{ type: 'text', text: JSON.stringify({ merged: a.number }) }],
  }));
  return server;
});

app.all('/mcp', async (c) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const valid = bearer && access.get(bearer)?.expiresAt > Date.now();
  if (!valid) {
    // Google-like: no hint at all; the client must derive the metadata URL from the path.
    if (!GOOGLE_LIKE) c.header('www-authenticate', `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    return c.json({ error: 'unauthorized' }, 401);
  }
  return handler.fetch(c.req.raw, {
    authInfo: { token: bearer, clientId: 'fake', scopes: [], extra: { stack: c.req.header('x-fake-stack') ?? null } },
    parsedBody: c.get('parsedBody'),
  });
});

serve({ fetch: app.fetch, port: PORT }, () => console.error(`fake vendor on :${PORT}${NO_REG ? ' (no registration)' : ''}`));
