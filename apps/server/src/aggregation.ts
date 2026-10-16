/**
 * MCP aggregation.
 *
 * External servers are re-exposed through the session endpoint as
 * `<slug>__<tool>`, and every call routes to the **calling participant's own**
 * credential — never the session's, and never someone else's (ADR 0004). The one
 * exception is a TEAM credential (M30, ADR 0028): in a team's sessions its members
 * use it where they have attached none of their own, marked as shared. A server
 * a participant has not attached is absent from their tool list entirely, rather
 * than present-and-denied, which would leak the session's topology.
 *
 * HTTP only. See ADR 0014 for why stdio is not here.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Database } from '@fabrikka/db';
import { freshAccessToken } from './connections/oauth.ts';
import {
  mcpServers,
  open as openSealed,
  participants,
  seal,
  sessionMcpServers,
  sessionMcpToolGrants,
  grantDefaults,
  sessions,
  teamMcpCalls,
  teamMcpServers,
  teamMembers,
  teams,
  users,
} from '@fabrikka/db';

/** Namespacing separator. Double underscore, as in `github__create_issue`. */
const SEP = '__';

export interface AttachedServer {
  id: string;
  slug: string;
  label: string;
  url: string;
  hasCredential: boolean;
}

/**
 * ADR 0043: a connection's scope. Null is Personal (rooms outside any
 * organization); otherwise the organization (a `team` in the code, ADR 0042).
 */
export type Scope = string | null;

/** The organization a room is in, or null: the scope its connections must have. */
export async function roomScopeOf(db: Database, sessionId: string): Promise<Scope> {
  const [row] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return row?.teamId ?? null;
}

const inScope = (teamId: Scope) => (teamId ? eq(mcpServers.teamId, teamId) : isNull(mcpServers.teamId));

/**
 * ADR 0043 (amended 2026-10-14): what a room may use. An organization's room:
 * that organization's connections and your all-rooms ones (team_id null), one
 * per vendor with the organization's winning; a room in none: all-rooms ones.
 */
export async function usableConnections(
  db: Database,
  userId: string,
  scope: Scope,
): Promise<Awaited<ReturnType<typeof listConnections>>> {
  const all = (await listConnections(db, userId, 'all')).filter((c) => c.teamId === null || c.teamId === scope);
  const bySlug = new Map<string, (typeof all)[number]>();
  for (const c of all) {
    const have = bySlug.get(c.slug);
    if (!have || (have.teamId === null && c.teamId !== null)) bySlug.set(c.slug, c);
  }
  return [...bySlug.values()];
}

/**
 * A server a participant may use in a session: their own, or — where they have
 * none for that slug — their team's (M30). `team` is set exactly when it is shared.
 */
export interface UsableServer extends AttachedServer {
  team?: { id: string; name: string };
}

export interface AggregatedTool {
  /** Namespaced name as the agent sees it. */
  name: string;
  slug: string;
  upstreamName: string;
  description?: string;
  inputSchema: unknown;
  /** The team whose shared credential backs this tool; absent when it is your own. */
  sharedBy?: string;
}

/* -------------------------------------------------------------------------- */
/* Attaching                                                                  */
/* -------------------------------------------------------------------------- */

export type AttachResult =
  | { ok: true; server: AttachedServer }
  | { ok: false; error: string };

/**
 * Register one of a user's own integrations and add it to a session.
 *
 * The credential is sealed here or the call fails — there is no path that stores
 * it in plaintext.
 */
/**
 * Save a person's own connection (M28: from the Personal integrations page, or
 * while attaching in a session). Re-saving without a credential keeps the one
 * already sealed.
 */
/**
 * The checks every connection passes, personal or team: a slug, an http(s) URL,
 * and a credential sealed here or not at all.
 */
function checkConnection(opts: {
  slug: string;
  url: string;
  credential?: string;
}): { ok: true; slug: string; sealed: string | null } | { ok: false; error: string } {
  const slug = opts.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    return { ok: false, error: 'slug must be lowercase letters, digits, - or _' };
  }

  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    return { ok: false, error: 'url must be a valid http(s) URL' };
  }
  // The only transport we aggregate. A command would make this an executor.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'only http(s) MCP servers can be aggregated — local servers belong to the bridge',
    };
  }

  let sealed: string | null = null;
  if (opts.credential) {
    try {
      sealed = seal(opts.credential);
    } catch (err) {
      // Unavailable beats insecure.
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: true, slug, sealed };
}

export async function saveConnection(
  db: Database,
  opts: {
    userId: string;
    slug: string;
    label?: string;
    url: string;
    credential?: string;
    /**
     * Basic sign-in (an email and an API token, e.g. Atlassian's personal API
     * tokens): the credential is then sent as `Basic base64(username:credential)`.
     */
    username?: string;
    /** ADR 0043: which organization's rooms may use it; null or absent for Personal. */
    teamId?: Scope;
  },
): Promise<{ ok: true; server: AttachedServer } | { ok: false; error: string }> {
  const username = opts.username?.trim();
  if (username && !opts.credential) return { ok: false, error: 'an API token is required with an email' };
  if (username?.includes(':')) return { ok: false, error: 'the email cannot contain ":"' };
  // Basic: seal the encoded pair, so the call only has to prefix it.
  const credential = username ? Buffer.from(`${username}:${opts.credential}`).toString('base64') : opts.credential;
  const checked = checkConnection({ ...opts, credential });
  if (!checked.ok) return checked;
  const { slug, sealed } = checked;
  const auth = username ? 'basic' : 'token';

  const [row] = await db
    .insert(mcpServers)
    .values({
      ownerId: opts.userId,
      slug,
      label: opts.label?.trim() || slug,
      url: opts.url,
      sealedCredential: sealed,
      auth,
      teamId: opts.teamId ?? null,
    })
    .onConflictDoUpdate({
      target: [mcpServers.ownerId, mcpServers.teamId, mcpServers.slug],
      set: {
        label: opts.label?.trim() || slug,
        url: opts.url,
        // Re-attaching without a credential keeps the existing one, and its scheme.
        ...(sealed ? { sealedCredential: sealed, auth } : {}),
      },
    })
    .returning();

  return {
    ok: true,
    server: { id: row!.id, slug: row!.slug, label: row!.label, url: row!.url, hasCredential: !!row!.sealedCredential },
  };
}

/**
 * Attach one of the caller's connections to a session. With a url, the
 * connection is saved (or updated) first; with only a slug, an existing one is
 * attached as it is (M28).
 */
export async function attachServer(
  db: Database,
  opts: {
    sessionId: string;
    userId: string;
    slug: string;
    label?: string;
    url?: string;
    credential?: string;
  },
): Promise<AttachResult> {
  // ADR 0043 (amended): the room's organization's connection, else your all-rooms one.
  const scope = await roomScopeOf(db, opts.sessionId);
  let server: AttachedServer;
  if (opts.url) {
    const saved = await saveConnection(db, { ...opts, url: opts.url, teamId: scope });
    if (!saved.ok) return saved;
    server = saved.server;
  } else {
    const existing = (await usableConnections(db, opts.userId, scope)).find((c) => c.slug === opts.slug.trim().toLowerCase());
    if (!existing) {
      const elsewhere = (await listConnections(db, opts.userId, 'all')).some((c) => c.slug === opts.slug.trim().toLowerCase());
      return {
        ok: false,
        error: elsewhere
          ? `your ${opts.slug} connection is for another organization only — connect it for all your rooms, or for ${scope ? 'this one' : 'Personal'}`
          : 'no connection with that slug — add it with a url first',
      };
    }
    server = existing;
  }

  await db
    .insert(sessionMcpServers)
    .values({ sessionId: opts.sessionId, mcpServerId: server.id, addedByUserId: opts.userId })
    .onConflictDoNothing();

  return { ok: true, server };
}

/**
 * A person's connections in one scope (ADR 0043), or 'all' of them, and how many
 * sessions each is attached to (M28).
 */
export async function listConnections(
  db: Database,
  userId: string,
  scope: Scope | 'all',
): Promise<(AttachedServer & { sessions: number; entry: string | null; auth: string; status: string; teamId: string | null })[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      slug: mcpServers.slug,
      label: mcpServers.label,
      url: mcpServers.url,
      sealed: mcpServers.sealedCredential,
      entry: mcpServers.entry,
      auth: mcpServers.auth,
      status: mcpServers.status,
      teamId: mcpServers.teamId,
      sessions: sql<number>`(select count(*) from ${sessionMcpServers} sms where sms.mcp_server_id = ${mcpServers.id})`,
    })
    .from(mcpServers)
    .where(scope === 'all' ? eq(mcpServers.ownerId, userId) : and(eq(mcpServers.ownerId, userId), inScope(scope)))
    .orderBy(mcpServers.slug);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    url: r.url,
    hasCredential: !!r.sealed,
    sessions: Number(r.sessions),
    // M18: which catalogue entry, how it signs in, and whether it needs reconnecting.
    entry: r.entry,
    auth: r.auth,
    status: r.status,
    teamId: r.teamId,
  }));
}

/** Remove a connection everywhere: it is detached from every session it was in. */
export async function removeConnection(db: Database, userId: string, slug: string, scope: Scope): Promise<boolean> {
  const done = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.ownerId, userId), eq(mcpServers.slug, slug), inScope(scope)))
    .returning({ id: mcpServers.id });
  return done.length > 0;
}

export async function detachServer(
  db: Database,
  sessionId: string,
  userId: string,
  slug: string,
): Promise<boolean> {
  // ADR 0043: a person may have one per organization; detach whichever is attached here.
  const rows = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.ownerId, userId), eq(mcpServers.slug, slug)));
  if (!rows.length) return false;

  const deleted = await db
    .delete(sessionMcpServers)
    .where(
      and(
        eq(sessionMcpServers.sessionId, sessionId),
        inArray(sessionMcpServers.mcpServerId, rows.map((r) => r.id)),
      ),
    )
    .returning({ id: sessionMcpServers.mcpServerId });
  return deleted.length > 0;
}

/** Integrations a given USER has attached to this session. */
export async function serversForUser(
  db: Database,
  sessionId: string,
  userId: string,
): Promise<AttachedServer[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      slug: mcpServers.slug,
      label: mcpServers.label,
      url: mcpServers.url,
      sealed: mcpServers.sealedCredential,
      teamId: mcpServers.teamId,
    })
    .from(sessionMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, sessionMcpServers.mcpServerId))
    .innerJoin(sessions, eq(sessions.id, sessionMcpServers.sessionId))
    .where(
      and(
        eq(sessionMcpServers.sessionId, sessionId),
        eq(mcpServers.ownerId, userId),
        // ADR 0043 (amended 2026-10-14): an all-rooms connection, or the room's
        // organization's; never an organization's once you've left it.
        sql`(${mcpServers.teamId} is null or ${mcpServers.teamId} = ${sessions.teamId})`,
        sql`(${mcpServers.teamId} is null or exists (
             select 1 from ${teamMembers} tm where tm.team_id = ${mcpServers.teamId} and tm.user_id = ${userId}))`,
      ),
    );

  // One per vendor: the organization's beats the all-rooms one.
  const bySlug = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const have = bySlug.get(r.slug);
    if (!have || (have.teamId === null && r.teamId !== null)) bySlug.set(r.slug, r);
  }
  return [...bySlug.values()].map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    url: r.url,
    hasCredential: !!r.sealed,
  }));
}

/** Every integration slug present in the session, for the grants UI. */
export async function slugsInSession(
  db: Database,
  sessionId: string,
): Promise<{ slug: string; label: string; attachedBy: number }[]> {
  const rows = await db
    .select({ slug: mcpServers.slug, label: mcpServers.label })
    .from(sessionMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, sessionMcpServers.mcpServerId))
    .where(eq(sessionMcpServers.sessionId, sessionId));

  const counts = new Map<string, { label: string; n: number }>();
  for (const r of rows) {
    const found = counts.get(r.slug);
    if (found) found.n += 1;
    else counts.set(r.slug, { label: r.label, n: 1 });
  }
  return [...counts].map(([slug, v]) => ({
    slug,
    label: v.label,
    attachedBy: v.n,
  }));
}

/* -------------------------------------------------------------------------- */
/* Team credentials (M30, ADR 0028)                                           */
/* -------------------------------------------------------------------------- */

export interface TeamConnection {
  id: string;
  slug: string;
  label: string;
  url: string;
  hasCredential: boolean;
  addedBy: string | null;
  createdAt: string;
}

/** A team's shared connections — never the credential, only whether one is set. */
export async function listTeamConnections(db: Database, teamId: string): Promise<TeamConnection[]> {
  const rows = await db
    .select({
      id: teamMcpServers.id,
      slug: teamMcpServers.slug,
      label: teamMcpServers.label,
      url: teamMcpServers.url,
      sealed: teamMcpServers.sealedCredential,
      addedBy: users.displayName,
      createdAt: teamMcpServers.createdAt,
    })
    .from(teamMcpServers)
    .leftJoin(users, eq(users.id, teamMcpServers.addedByUserId))
    .where(eq(teamMcpServers.teamId, teamId))
    .orderBy(teamMcpServers.slug);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    url: r.url,
    hasCredential: !!r.sealed,
    addedBy: r.addedBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Add or replace one of the team's connections. The caller must already be known
 * to be a team OWNER — the route checks; this only stores. Re-saving without a
 * credential keeps the one already sealed.
 */
export async function saveTeamConnection(
  db: Database,
  opts: { teamId: string; userId: string; slug: string; label?: string; url: string; credential?: string },
): Promise<{ ok: true; connection: TeamConnection } | { ok: false; error: string }> {
  const checked = checkConnection(opts);
  if (!checked.ok) return checked;
  const label = opts.label?.trim() || checked.slug;

  await db
    .insert(teamMcpServers)
    .values({
      teamId: opts.teamId,
      slug: checked.slug,
      label,
      url: opts.url,
      sealedCredential: checked.sealed,
      addedByUserId: opts.userId,
    })
    .onConflictDoUpdate({
      target: [teamMcpServers.teamId, teamMcpServers.slug],
      set: {
        label,
        url: opts.url,
        addedByUserId: opts.userId,
        ...(checked.sealed ? { sealedCredential: checked.sealed } : {}),
      },
    });
  const saved = (await listTeamConnections(db, opts.teamId)).find((c) => c.slug === checked.slug)!;
  return { ok: true, connection: saved };
}

/** Remove one of the team's connections: gone from every session of the team at once. */
export async function removeTeamConnection(db: Database, teamId: string, slug: string): Promise<boolean> {
  const done = await db
    .delete(teamMcpServers)
    .where(and(eq(teamMcpServers.teamId, teamId), eq(teamMcpServers.slug, slug)))
    .returning({ id: teamMcpServers.id });
  return done.length > 0;
}

/** M43: how long a team keeps its call records. The only answers the privacy policy names. */
export const CALL_RECORD_DAYS = [30, 60, 90, 180, 365] as const;

export async function callRecordDays(db: Database, teamId: string): Promise<number> {
  const [row] = await db.select({ days: teams.callRecordDays }).from(teams).where(eq(teams.id, teamId)).limit(1);
  return row?.days ?? 90;
}

/** Team owners only (checked by the caller). Shortening it deletes the older records at once. */
export async function setCallRecordDays(db: Database, teamId: string, days: number): Promise<void> {
  await db.update(teams).set({ callRecordDays: days }).where(eq(teams.id, teamId));
  await pruneTeamCalls(db, teamId);
}

/**
 * Delete call records older than their team's setting: one team, or every team.
 * Runs at start, daily after that, and when a team shortens its setting.
 */
export async function pruneTeamCalls(db: Database, teamId?: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    delete from team_mcp_calls c
    using team_mcp_servers s, teams t
    where c.team_mcp_server_id = s.id
      and s.team_id = t.id
      and c.created_at < now() - make_interval(days => t.call_record_days)
      ${teamId ? sql`and t.id = ${teamId}` : sql``}
    returning c.id`);
  return rows.length;
}

/** Recent calls made with the team's credentials, newest first. For team owners. */
export async function teamConnectionUses(
  db: Database,
  teamId: string,
  limit = 50,
): Promise<{ slug: string; toolName: string; person: string | null; agent: string | null; session: string | null; ok: boolean; at: string }[]> {
  const rows = await db
    .select({
      slug: teamMcpServers.slug,
      toolName: teamMcpCalls.toolName,
      person: users.displayName,
      agent: teamMcpCalls.agentName,
      session: sessions.title,
      ok: teamMcpCalls.ok,
      at: teamMcpCalls.createdAt,
    })
    .from(teamMcpCalls)
    .innerJoin(teamMcpServers, eq(teamMcpServers.id, teamMcpCalls.teamMcpServerId))
    .leftJoin(users, eq(users.id, teamMcpCalls.userId))
    .leftJoin(sessions, eq(sessions.id, teamMcpCalls.sessionId))
    .where(eq(teamMcpServers.teamId, teamId))
    .orderBy(desc(teamMcpCalls.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

/**
 * The team credentials a user may use in this session: the session must belong to
 * a team, and the user must be on it NOW. Derived on every call — leaving the team
 * ends access with nothing to clean up (so did moving the session, until ADR 0050).
 */
export async function teamServersFor(db: Database, sessionId: string, userId: string): Promise<UsableServer[]> {
  const rows = await db
    .select({
      id: teamMcpServers.id,
      slug: teamMcpServers.slug,
      label: teamMcpServers.label,
      url: teamMcpServers.url,
      sealed: teamMcpServers.sealedCredential,
      teamId: teams.id,
      teamName: teams.name,
    })
    .from(sessions)
    .innerJoin(teams, eq(teams.id, sessions.teamId))
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
    .innerJoin(teamMcpServers, eq(teamMcpServers.teamId, teams.id))
    .where(eq(sessions.id, sessionId));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    url: r.url,
    hasCredential: !!r.sealed,
    team: { id: r.teamId, name: r.teamName },
  }));
}

/**
 * Everything a user may use in this session: their own attached servers, plus the
 * team's for every slug they have none of. Their own always wins (ADR 0028).
 */
export async function usableServers(db: Database, sessionId: string, userId: string): Promise<UsableServer[]> {
  const own = await serversForUser(db, sessionId, userId);
  const mine = new Set(own.map((s) => s.slug));
  const team = (await teamServersFor(db, sessionId, userId)).filter((s) => !mine.has(s.slug));
  return [...own, ...team];
}

/* -------------------------------------------------------------------------- */
/* Grants                                                                     */
/* -------------------------------------------------------------------------- */

export async function grantedTools(
  db: Database,
  sessionId: string,
  slugs: string[],
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();

  const rows = await db
    .select()
    .from(sessionMcpToolGrants)
    .where(
      and(
        eq(sessionMcpToolGrants.sessionId, sessionId),
        inArray(sessionMcpToolGrants.serverSlug, slugs),
      ),
    );

  // Absent means denied, so only `allowed` rows count.
  return new Set(
    rows.filter((r) => r.allowed).map((r) => `${r.serverSlug}${SEP}${r.toolName}`),
  );
}

export async function setGrant(
  db: Database,
  sessionId: string,
  serverSlug: string,
  toolName: string,
  allowed: boolean,
): Promise<void> {
  await db
    .insert(sessionMcpToolGrants)
    .values({ sessionId, serverSlug, toolName, allowed })
    .onConflictDoUpdate({
      target: [
        sessionMcpToolGrants.sessionId,
        sessionMcpToolGrants.serverSlug,
        sessionMcpToolGrants.toolName,
      ],
      set: { allowed },
    });
}

export async function listGrants(
  db: Database,
  sessionId: string,
): Promise<{ serverSlug: string; toolName: string; allowed: boolean }[]> {
  return db
    .select({
      serverSlug: sessionMcpToolGrants.serverSlug,
      toolName: sessionMcpToolGrants.toolName,
      allowed: sessionMcpToolGrants.allowed,
    })
    .from(sessionMcpToolGrants)
    .where(eq(sessionMcpToolGrants.sessionId, sessionId));
}

/**
 * M52 (ADR 0049): make a session's grants for one slug exactly `allowed`:
 * those tools on, every other row of that slug off. Absent still means denied.
 */
export async function replaceGrants(db: Database, sessionId: string, serverSlug: string, allowed: string[]): Promise<void> {
  const keep = new Set(allowed);
  await db
    .update(sessionMcpToolGrants)
    .set({ allowed: false })
    .where(and(eq(sessionMcpToolGrants.sessionId, sessionId), eq(sessionMcpToolGrants.serverSlug, serverSlug)));
  for (const toolName of keep) await setGrant(db, sessionId, serverSlug, toolName, true);
}

/** M52: the grants a person usually allows, per integration. */
export async function listGrantDefaults(db: Database, userId: string): Promise<{ slug: string; name: string; tools: string[]; updatedAt: string }[]> {
  const rows = await db.select().from(grantDefaults).where(eq(grantDefaults.userId, userId));
  return rows.map((r) => ({ slug: r.serverSlug, name: r.name, tools: r.tools, updatedAt: r.updatedAt.toISOString() }));
}

export async function saveGrantDefault(db: Database, userId: string, serverSlug: string, name: string, tools: string[]): Promise<void> {
  await db
    .insert(grantDefaults)
    .values({ userId, serverSlug, name, tools })
    .onConflictDoUpdate({ target: [grantDefaults.userId, grantDefaults.serverSlug, grantDefaults.name], set: { tools, updatedAt: new Date() } });
}

export async function removeGrantDefault(db: Database, userId: string, serverSlug: string, name: string): Promise<boolean> {
  const gone = await db
    .delete(grantDefaults)
    .where(and(eq(grantDefaults.userId, userId), eq(grantDefaults.serverSlug, serverSlug), eq(grantDefaults.name, name)))
    .returning({ name: grantDefaults.name });
  return gone.length > 0;
}

/**
 * M52: apply a person's default to a session's grants for one slug. The caller
 * checks that the person owns the session. Null when there is no such default.
 */
export async function applyGrantDefault(db: Database, sessionId: string, userId: string, serverSlug: string, name = 'default'): Promise<number | null> {
  const [row] = await db
    .select({ tools: grantDefaults.tools })
    .from(grantDefaults)
    .where(and(eq(grantDefaults.userId, userId), eq(grantDefaults.serverSlug, serverSlug), eq(grantDefaults.name, name)));
  if (!row) return null;
  await replaceGrants(db, sessionId, serverSlug, row.tools);
  return row.tools.length;
}

/** M52: whether a session has any grant row for a slug (even a denied one). */
export async function hasGrants(db: Database, sessionId: string, serverSlug: string): Promise<boolean> {
  const rows = await db
    .select({ toolName: sessionMcpToolGrants.toolName })
    .from(sessionMcpToolGrants)
    .where(and(eq(sessionMcpToolGrants.sessionId, sessionId), eq(sessionMcpToolGrants.serverSlug, serverSlug)))
    .limit(1);
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Upstream connections                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Connect to one upstream server with a specific credential.
 *
 * A fresh client per operation. Pooling would mean holding a decrypted credential
 * in memory between requests, keyed by user, which is a larger thing to get right
 * than it is worth at this scale.
 */
async function connect(
  url: string,
  credential: string | null,
  extraHeaders: Record<string, string> = {},
  scheme: 'Bearer' | 'Basic' = 'Bearer',
): Promise<Client> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (credential) headers.Authorization = `${scheme} ${credential}`;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: Object.keys(headers).length ? { headers } : undefined,
  });
  const client = new Client({ name: 'fabrikka-aggregator', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

/** Decrypt the credential behind a usable server — a person's own, or the team's. */
async function credentialFor(
  db: Database,
  server: Pick<UsableServer, 'id' | 'team'>,
): Promise<{ url: string; credential: string | null; headers: Record<string, string>; scheme?: 'Bearer' | 'Basic' } | null> {
  if (server.team) {
    const [row] = await db
      .select({ url: teamMcpServers.url, sealed: teamMcpServers.sealedCredential })
      .from(teamMcpServers)
      .where(eq(teamMcpServers.id, server.id))
      .limit(1);
    return row ? { url: row.url, credential: openSealed(row.sealed), headers: {} } : null;
  }
  const [row] = await db
    .select({ url: mcpServers.url, sealed: mcpServers.sealedCredential, auth: mcpServers.auth, headers: mcpServers.headers })
    .from(mcpServers)
    .where(eq(mcpServers.id, server.id))
    .limit(1);
  if (!row) return null;
  // M18: an OAuth connection is refreshed first when its token is about to
  // expire. A failed refresh leaves it needs_reconnect, and its tools absent.
  if (row.auth === 'oauth') {
    const token = await freshAccessToken(db, server.id);
    return token ? { url: row.url, credential: token, headers: row.headers ?? {} } : null;
  }
  return { url: row.url, credential: openSealed(row.sealed), headers: row.headers ?? {}, scheme: row.auth === 'basic' ? 'Basic' : 'Bearer' };
}

/**
 * The tools a specific participant may use in this session.
 *
 * Intersection of: servers THEY may use (their own, or their team's where they
 * have none — M30), and tools the SESSION granted. A participant who has nothing
 * gets an empty list and cannot tell what anyone else attached.
 */
export async function toolsForParticipant(
  db: Database,
  sessionId: string,
  participantId: string,
): Promise<AggregatedTool[]> {
  const who = await identify(db, sessionId, participantId);
  if (!who) return [];

  const servers = await usableServers(db, sessionId, who.userId);
  if (servers.length === 0) return [];

  const granted = await grantedTools(db, sessionId, servers.map((s) => s.slug));
  if (granted.size === 0) return [];

  const tools: AggregatedTool[] = [];

  for (const server of servers) {
    const conn = await credentialFor(db, server);
    if (!conn) continue;

    let client: Client | undefined;
    try {
      client = await connect(conn.url, conn.credential, conn.headers, conn.scheme);
      const { tools: upstream } = await client.listTools();

      for (const t of upstream) {
        const name = `${server.slug}${SEP}${t.name}`;
        if (!granted.has(name)) continue;
        tools.push({
          name,
          slug: server.slug,
          upstreamName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          sharedBy: server.team?.name,
        });
      }
    } catch (err) {
      // One unreachable integration must not remove every other tool from the
      // agent's list; it simply contributes nothing this time.
      console.error(`[aggregation] ${server.slug} unreachable:`, (err as Error).message);
    } finally {
      await client?.close().catch(() => {});
    }
  }

  return tools;
}

/** Tools an upstream server offers, for the grants UI. Owner-facing. */
export async function discoverTools(
  db: Database,
  server: Pick<UsableServer, 'id' | 'team'>,
): Promise<{ name: string; description?: string }[]> {
  const conn = await credentialFor(db, server);
  if (!conn) return [];

  let client: Client | undefined;
  try {
    client = await connect(conn.url, conn.credential, conn.headers, conn.scheme);
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description }));
  } catch (err) {
    console.error('[aggregation] discovery failed:', (err as Error).message);
    return [];
  } finally {
    await client?.close().catch(() => {});
  }
}

export type CallResult =
  | { ok: true; content: unknown }
  | { ok: false; error: string };

/**
 * Call an aggregated tool as a specific participant.
 *
 * Re-checks the grant, the participant's own attachment and their team
 * membership at call time rather than trusting the earlier list: any of them may
 * have changed since. A call made with a team credential is recorded with who
 * made it (ADR 0028).
 */
export async function callAggregatedTool(
  db: Database,
  opts: {
    sessionId: string;
    participantId: string;
    toolName: string;
    args: Record<string, unknown>;
  },
): Promise<CallResult> {
  const [slug, ...rest] = opts.toolName.split(SEP);
  const upstreamName = rest.join(SEP);
  if (!slug || !upstreamName) return { ok: false, error: 'unknown tool' };

  const who = await identify(db, opts.sessionId, opts.participantId);
  if (!who) return { ok: false, error: 'unknown tool' };

  const servers = await usableServers(db, opts.sessionId, who.userId);
  const server = servers.find((s) => s.slug === slug);
  // Not usable BY THIS PARTICIPANT: indistinguishable from not existing, so a
  // caller cannot probe what others have attached.
  if (!server) return { ok: false, error: 'unknown tool' };

  const granted = await grantedTools(db, opts.sessionId, [slug]);
  if (!granted.has(opts.toolName)) {
    return { ok: false, error: `${opts.toolName} is not permitted in this session` };
  }

  const conn = await credentialFor(db, server);
  if (!conn) return { ok: false, error: 'unknown tool' };

  // The vendor's log will name the team's account; this row names who acted.
  const record = (ok: boolean) =>
    server.team
      ? db
          .insert(teamMcpCalls)
          .values({
            teamMcpServerId: server.id,
            sessionId: opts.sessionId,
            userId: who.userId,
            agentName: who.agentName,
            toolName: upstreamName,
            ok,
          })
          .then(() => {})
          .catch((err) => console.error('[aggregation] could not record a team call:', (err as Error).message))
      : Promise.resolve();

  let client: Client | undefined;
  try {
    client = await connect(conn.url, conn.credential, conn.headers, conn.scheme);
    const result = await client.callTool({ name: upstreamName, arguments: opts.args });
    await record(!result.isError);
    return { ok: true, content: result.content };
  } catch (err) {
    await record(false);
    return { ok: false, error: `${slug} call failed: ${(err as Error).message}` };
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Whose credentials a participant acts with: a person's own, or — for an agent —
 * its owner's (ADR 0004). Null for anyone else.
 */
async function identify(
  db: Database,
  sessionId: string,
  participantId: string,
): Promise<{ userId: string; agentName: string | null } | null> {
  const [row] = await db
    .select({
      userId: participants.userId,
      sessionAgentId: participants.sessionAgentId,
      displayName: participants.displayName,
    })
    .from(participants)
    .where(
      and(eq(participants.id, participantId), eq(participants.sessionId, sessionId)),
    )
    .limit(1);

  if (!row) return null;
  if (row.userId) return { userId: row.userId, agentName: null };

  // An agent acts with ITS OWNER's credentials — that is what makes audit
  // attribution correct upstream (ADR 0004).
  if (row.sessionAgentId) {
    const owner = await ownerOfAgent(db, row.sessionAgentId);
    return owner ? { userId: owner, agentName: row.displayName } : null;
  }
  return null;
}

async function ownerOfAgent(
  db: Database,
  sessionAgentId: string,
): Promise<string | null> {
  const { agents, sessionAgents } = await import('@fabrikka/db');
  const [row] = await db
    .select({ ownerId: agents.ownerId })
    .from(sessionAgents)
    .innerJoin(agents, eq(agents.id, sessionAgents.agentId))
    .where(eq(sessionAgents.id, sessionAgentId))
    .limit(1);
  return row?.ownerId ?? null;
}
