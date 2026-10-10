/**
 * Connecting a vendor's MCP server over OAuth (M18, ADR 0024), per the MCP
 * authorization spec: protected-resource discovery (RFC 9728), authorization-
 * server metadata (RFC 8414), dynamic client registration (RFC 7591) where the
 * vendor offers it, PKCE (S256), and the resource indicator (RFC 8707).
 *
 * Fabrikka signs in AS THE PERSON. Their tokens are sealed, per user, and
 * every call still goes out under the caller's own credential (ADR 0004).
 * See docs/security.md, "Connecting vendors over OAuth".
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { mcpServers, oauthClients, oauthFlows, open as openSealed, seal } from '@fabrikka/db';
import { findEntry } from './catalogue/registry.ts';
import type { CatalogueEntry } from './catalogue/types.ts';

const FLOW_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before expiry, so a call never races the clock. */
const REFRESH_EARLY_MS = 60 * 1000;

export class OAuthError extends Error {}

export const callbackPath = '/api/connections/oauth/callback';

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const hashState = (state: string) => sha256(state).toString('hex');

/**
 * Only https — except localhost, for a local instance and its tests. Discovery
 * follows URLs from vendor metadata; this keeps it off internal plain-http hosts.
 */
function safeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthError(`not a URL: ${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new OAuthError(`refusing a non-https URL: ${u.origin}`);
  return u;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(safeUrl(url), { headers: { accept: 'application/json' } }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/** RFC 8414 metadata URL: the well-known path goes between the host and the issuer's path. */
function metadataUrl(issuer: string): string {
  const u = safeUrl(issuer);
  const path = u.pathname.replace(/\/$/, '');
  return `${u.origin}/.well-known/oauth-authorization-server${path === '' ? '' : path}`;
}

/**
 * Where to sign in for this MCP server. An unauthenticated request's 401 names
 * the resource metadata (RFC 9728); a server that names none (Atlassian) has its
 * authorization-server metadata at its own origin.
 */
export async function discover(mcpUrl: string): Promise<AuthServer> {
  const res = await fetch(safeUrl(mcpUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fabrikka', version: '0' } } }),
  }).catch(() => null);
  const challenge = res?.headers.get('www-authenticate') ?? '';
  const resourceMetadata = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];

  let issuer = new URL(mcpUrl).origin;
  if (resourceMetadata) {
    const rm = await getJson(resourceMetadata);
    const servers = rm?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === 'string') issuer = servers[0];
  }
  const meta = await getJson(metadataUrl(issuer));
  if (!meta || typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new OAuthError(`no OAuth metadata for ${new URL(mcpUrl).host}`);
  }
  const pkce = meta.code_challenge_methods_supported;
  if (Array.isArray(pkce) && !pkce.includes('S256')) throw new OAuthError('the vendor does not support PKCE (S256)');
  return {
    issuer: String(meta.issuer ?? issuer),
    authorizationEndpoint: safeUrl(meta.authorization_endpoint).href,
    tokenEndpoint: safeUrl(meta.token_endpoint).href,
    registrationEndpoint: typeof meta.registration_endpoint === 'string' ? safeUrl(meta.registration_endpoint).href : null,
  };
}

interface Client {
  /** Our row, for a dynamically registered client; null for one from the environment. */
  rowId: string | null;
  clientId: string;
  clientSecret: string | null;
}

/** The client this instance uses with an authorization server: the environment's, or a registered one. */
async function clientFor(db: Database, entry: CatalogueEntry, as: AuthServer, redirectUri: string): Promise<Client> {
  const pre = entry.auth.client;
  if (pre) {
    const id = process.env[pre.idEnv];
    const secret = process.env[pre.secretEnv];
    if (!id || !secret) throw new OAuthError(`${entry.name} needs ${pre.idEnv} and ${pre.secretEnv} on the instance`);
    return { rowId: null, clientId: id, clientSecret: secret };
  }
  const [known] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.issuer, as.issuer), eq(oauthClients.redirectUri, redirectUri)))
    .limit(1);
  if (known) return { rowId: known.id, clientId: known.clientId, clientSecret: openSealed(known.sealedClientSecret) };
  if (!as.registrationEndpoint) throw new OAuthError(`${entry.name} needs a pre-registered client: it offers no dynamic registration`);

  // Per instance: the first person to connect registers it; everyone after reuses it.
  const res = await fetch(as.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Fabrikka',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const reg = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
  if (!res.ok || !reg.client_id) throw new OAuthError(`${entry.name} refused to register Fabrikka (${res.status})`);
  const [row] = await db
    .insert(oauthClients)
    .values({ issuer: as.issuer, redirectUri, clientId: reg.client_id, sealedClientSecret: reg.client_secret ? seal(reg.client_secret) : null })
    .onConflictDoNothing()
    .returning();
  if (row) return { rowId: row.id, clientId: row.clientId, clientSecret: reg.client_secret ?? null };
  // Two people registered at once: use whichever landed first.
  return clientFor(db, entry, as, redirectUri);
}

function checkFields(entry: CatalogueEntry, fields: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const f of entry.fields ?? []) {
    const v = (fields[f.key] ?? '').trim();
    if (!v) {
      if (f.required) throw new OAuthError(`${f.label} is required`);
      continue;
    }
    // https-url: a field may only ever be a vendor URL, never an internal one.
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new OAuthError(`${f.label} must be a URL`);
    }
    if (u.protocol !== 'https:') throw new OAuthError(`${f.label} must start with https://`);
    headers[f.header] = u.origin;
  }
  return headers;
}

/* ---- the desktop app's handoff to the default browser (ADR 0033) ---- */

export const handoffPath = '/api/connections/oauth/handoff';
/** Holds the flow's `state` in the browser that pressed Continue; scoped to the callback. */
export const handoffCookie = 'fabrikka_oauth_state';
export const HANDOFF_COOKIE_MAX_AGE_S = FLOW_TTL_MS / 1000;
const HANDOFF_TTL_MS = 5 * 60 * 1000;

export interface Handoff {
  userId: string;
  entryId: string;
  fields: Record<string, string>;
}

/**
 * A handoff URL for the signed-in app to open in the browser. The ticket is
 * sealed (AES-256-GCM: it can't be forged or edited) and expires in 5 minutes.
 * The vendor and its fields are checked now, so a mistake shows in the app.
 */
export function issueHandoff(opts: { userId: string; entryId: string; fields?: Record<string, string>; publicUrl: string }): string {
  const entry = findEntry(opts.entryId);
  if (!entry) throw new OAuthError('no such connection');
  checkFields(entry, opts.fields ?? {});
  const ticket = seal(JSON.stringify({ u: opts.userId, e: entry.id, f: opts.fields ?? {}, x: Date.now() + HANDOFF_TTL_MS }));
  const url = new URL(`${opts.publicUrl}${handoffPath}`);
  url.searchParams.set('t', ticket);
  return url.href;
}

/** The handoff a ticket names, or null if it's forged, edited or expired. */
export function readHandoff(ticket: string | undefined): Handoff | null {
  if (!ticket) return null;
  let raw: string | null;
  try {
    raw = openSealed(ticket);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { u?: unknown; e?: unknown; f?: unknown; x?: unknown };
    if (typeof t.u !== 'string' || typeof t.e !== 'string' || typeof t.x !== 'number' || t.x < Date.now()) return null;
    const fields = t.f && typeof t.f === 'object' ? (t.f as Record<string, string>) : {};
    return { userId: t.u, entryId: t.e, fields };
  } catch {
    return null;
  }
}

/** Begin connecting: returns the vendor's sign-in URL to send the browser to. */
export async function startFlow(
  db: Database,
  opts: { userId: string; entryId: string; fields?: Record<string, string>; publicUrl: string },
): Promise<string> {
  const entry = findEntry(opts.entryId);
  if (!entry) throw new OAuthError('no such connection');
  const headers = checkFields(entry, opts.fields ?? {});
  const redirectUri = `${opts.publicUrl}${callbackPath}`;
  const as = await discover(entry.mcpUrl);
  const client = await clientFor(db, entry, as, redirectUri);

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  await db.insert(oauthFlows).values({
    stateHash: hashState(state),
    userId: opts.userId,
    entry: entry.id,
    sealedVerifier: seal(verifier),
    oauthClientId: client.rowId,
    tokenEndpoint: as.tokenEndpoint,
    fields: headers,
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  });

  const url = new URL(as.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', b64url(sha256(verifier)));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', entry.mcpUrl);
  if (entry.auth.scopes?.length) url.searchParams.set('scope', entry.auth.scopes.join(' '));
  return url.href;
}

async function tokenRequest(
  endpoint: string,
  client: Client,
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret) body.set('client_secret', client.clientSecret);
  const res = await fetch(endpoint, {
    method: 'POST',
    // GitHub answers form-encoded unless asked for JSON.
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new OAuthError(String(json.error_description ?? json.error ?? `token request failed (${res.status})`));
  }
  return json as { access_token: string; refresh_token?: string; expires_in?: number };
}

async function clientById(db: Database, entry: CatalogueEntry, rowId: string | null): Promise<Client> {
  if (!rowId) {
    const pre = entry.auth.client;
    return { rowId: null, clientId: pre ? process.env[pre.idEnv] ?? '' : '', clientSecret: pre ? process.env[pre.secretEnv] ?? null : null };
  }
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, rowId)).limit(1);
  if (!row) throw new OAuthError('the registration for this vendor is gone — connect again');
  return { rowId: row.id, clientId: row.clientId, clientSecret: openSealed(row.sealedClientSecret) };
}

/**
 * The vendor sent the browser back. The flow must exist, be unexpired, and
 * belong to the person now signed in; it's consumed before the code is used.
 *
 * `userId: null` is the handoff (ADR 0033): no one is signed in in this browser,
 * but its handoff cookie held this exact `state`, so it is the browser that
 * pressed Continue for the flow's own user.
 */
export async function completeFlow(
  db: Database,
  opts: { userId: string | null; code: string; state: string; publicUrl: string },
): Promise<CatalogueEntry> {
  const [flow] = await db
    .delete(oauthFlows)
    .where(
      and(
        eq(oauthFlows.stateHash, hashState(opts.state)),
        opts.userId === null ? undefined : eq(oauthFlows.userId, opts.userId),
        gt(oauthFlows.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!flow) throw new OAuthError('this sign-in link is invalid, already used, expired, or not yours — start again');
  const entry = findEntry(flow.entry);
  if (!entry) throw new OAuthError('that connection is no longer offered');
  const client = await clientById(db, entry, flow.oauthClientId);

  const tokens = await tokenRequest(flow.tokenEndpoint, client, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: `${opts.publicUrl}${callbackPath}`,
    code_verifier: openSealed(flow.sealedVerifier) ?? '',
    resource: entry.mcpUrl,
  });

  const values = {
    label: entry.connectionName ?? entry.name,
    url: entry.mcpUrl,
    entry: entry.id,
    auth: 'oauth',
    sealedCredential: seal(tokens.access_token),
    sealedRefreshToken: tokens.refresh_token ? seal(tokens.refresh_token) : null,
    tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    oauthClientId: client.rowId,
    tokenEndpoint: flow.tokenEndpoint,
    headers: flow.fields ?? {},
    status: 'ok',
  };
  await db
    .insert(mcpServers)
    .values({ ownerId: flow.userId, slug: entry.slug, ...values })
    .onConflictDoUpdate({ target: [mcpServers.ownerId, mcpServers.slug], set: values });
  return entry;
}

/**
 * A usable access token for an OAuth connection, refreshed first when it's about
 * to expire. A refresh that fails marks the connection needs_reconnect and
 * returns null — the vendor's tools are then absent, and the UI says why.
 */
export async function freshAccessToken(db: Database, serverId: string): Promise<string | null> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
  if (!row || row.status !== 'ok') return null;
  const access = openSealed(row.sealedCredential);
  if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() - REFRESH_EARLY_MS > Date.now()) return access;

  const entry = row.entry ? findEntry(row.entry) : undefined;
  const refresh = openSealed(row.sealedRefreshToken);
  try {
    if (!entry || !refresh || !row.tokenEndpoint) throw new OAuthError('nothing to refresh with');
    const client = await clientById(db, entry, row.oauthClientId);
    const tokens = await tokenRequest(row.tokenEndpoint, client, { grant_type: 'refresh_token', refresh_token: refresh, resource: row.url });
    await db
      .update(mcpServers)
      .set({
        sealedCredential: seal(tokens.access_token),
        // Rotating refresh tokens: keep the new one; otherwise the old stays valid.
        ...(tokens.refresh_token ? { sealedRefreshToken: seal(tokens.refresh_token) } : {}),
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      })
      .where(eq(mcpServers.id, row.id));
    return tokens.access_token;
  } catch (err) {
    console.error(`[oauth] ${row.slug}: refresh failed — needs reconnecting:`, (err as Error).message);
    await db.update(mcpServers).set({ status: 'needs_reconnect' }).where(eq(mcpServers.id, row.id));
    return null;
  }
}
