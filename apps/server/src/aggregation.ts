/**
 * MCP aggregation.
 *
 * External servers are re-exposed through the session endpoint as
 * `<slug>__<tool>`, and every call routes to the **calling participant's own**
 * credential — never the session's, and never someone else's (ADR 0004). A server
 * a participant has not attached is absent from their tool list entirely, rather
 * than present-and-denied, which would leak the session's topology.
 *
 * HTTP only. See ADR 0014 for why stdio is not here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Database } from '@fabrikka/db';
import {
  mcpServers,
  open as openSealed,
  participants,
  seal,
  sessionMcpServers,
  sessionMcpToolGrants,
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

export interface AggregatedTool {
  /** Namespaced name as the agent sees it. */
  name: string;
  slug: string;
  upstreamName: string;
  description?: string;
  inputSchema: unknown;
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
export async function attachServer(
  db: Database,
  opts: {
    sessionId: string;
    userId: string;
    slug: string;
    label?: string;
    url: string;
    credential?: string;
  },
): Promise<AttachResult> {
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

  const [row] = await db
    .insert(mcpServers)
    .values({
      ownerId: opts.userId,
      slug,
      label: opts.label?.trim() || slug,
      url: opts.url,
      sealedCredential: sealed,
    })
    .onConflictDoUpdate({
      target: [mcpServers.ownerId, mcpServers.slug],
      set: {
        label: opts.label?.trim() || slug,
        url: opts.url,
        // Re-attaching without a credential keeps the existing one.
        ...(sealed ? { sealedCredential: sealed } : {}),
      },
    })
    .returning();

  await db
    .insert(sessionMcpServers)
    .values({
      sessionId: opts.sessionId,
      mcpServerId: row!.id,
      addedByUserId: opts.userId,
    })
    .onConflictDoNothing();

  return {
    ok: true,
    server: {
      id: row!.id,
      slug: row!.slug,
      label: row!.label,
      url: row!.url,
      hasCredential: !!row!.sealedCredential,
    },
  };
}

export async function detachServer(
  db: Database,
  sessionId: string,
  userId: string,
  slug: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.ownerId, userId), eq(mcpServers.slug, slug)))
    .limit(1);
  if (!rows[0]) return false;

  const deleted = await db
    .delete(sessionMcpServers)
    .where(
      and(
        eq(sessionMcpServers.sessionId, sessionId),
        eq(sessionMcpServers.mcpServerId, rows[0].id),
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
    })
    .from(sessionMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, sessionMcpServers.mcpServerId))
    .where(
      and(
        eq(sessionMcpServers.sessionId, sessionId),
        eq(mcpServers.ownerId, userId),
      ),
    );

  return rows.map((r) => ({
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
async function connect(url: string, credential: string | null): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: credential
      ? { headers: { Authorization: `Bearer ${credential}` } }
      : undefined,
  });
  const client = new Client({ name: 'fabrikka-aggregator', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

/** Decrypt a participant's credential for one upstream call. */
async function credentialFor(
  db: Database,
  serverId: string,
): Promise<{ url: string; credential: string | null } | null> {
  const [row] = await db
    .select({ url: mcpServers.url, sealed: mcpServers.sealedCredential })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  if (!row) return null;
  return { url: row.url, credential: openSealed(row.sealed) };
}

/**
 * The tools a specific participant may use in this session.
 *
 * Intersection of: servers THEY attached, and tools the SESSION granted. A
 * participant who has attached nothing gets an empty list and cannot tell what
 * anyone else attached.
 */
export async function toolsForParticipant(
  db: Database,
  sessionId: string,
  participantId: string,
): Promise<AggregatedTool[]> {
  const userId = await userForParticipant(db, sessionId, participantId);
  if (!userId) return [];

  const servers = await serversForUser(db, sessionId, userId);
  if (servers.length === 0) return [];

  const granted = await grantedTools(db, sessionId, servers.map((s) => s.slug));
  if (granted.size === 0) return [];

  const tools: AggregatedTool[] = [];

  for (const server of servers) {
    const conn = await credentialFor(db, server.id);
    if (!conn) continue;

    let client: Client | undefined;
    try {
      client = await connect(conn.url, conn.credential);
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
  serverId: string,
): Promise<{ name: string; description?: string }[]> {
  const conn = await credentialFor(db, serverId);
  if (!conn) return [];

  let client: Client | undefined;
  try {
    client = await connect(conn.url, conn.credential);
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
 * Re-checks the grant and the participant's own attachment at call time rather
 * than trusting the earlier list: a grant may have been revoked since.
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

  const userId = await userForParticipant(db, opts.sessionId, opts.participantId);
  if (!userId) return { ok: false, error: 'unknown tool' };

  const servers = await serversForUser(db, opts.sessionId, userId);
  const server = servers.find((s) => s.slug === slug);
  // Not attached BY THIS PARTICIPANT: indistinguishable from not existing, so a
  // caller cannot probe what others have attached.
  if (!server) return { ok: false, error: 'unknown tool' };

  const granted = await grantedTools(db, opts.sessionId, [slug]);
  if (!granted.has(opts.toolName)) {
    return { ok: false, error: `${opts.toolName} is not permitted in this session` };
  }

  const conn = await credentialFor(db, server.id);
  if (!conn) return { ok: false, error: 'unknown tool' };

  let client: Client | undefined;
  try {
    client = await connect(conn.url, conn.credential);
    const result = await client.callTool({ name: upstreamName, arguments: opts.args });
    return { ok: true, content: result.content };
  } catch (err) {
    return { ok: false, error: `${slug} call failed: ${(err as Error).message}` };
  } finally {
    await client?.close().catch(() => {});
  }
}

/** The user behind a participant, or null for an agent. */
async function userForParticipant(
  db: Database,
  sessionId: string,
  participantId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: participants.userId, sessionAgentId: participants.sessionAgentId })
    .from(participants)
    .where(
      and(eq(participants.id, participantId), eq(participants.sessionId, sessionId)),
    )
    .limit(1);

  if (!row) return null;
  if (row.userId) return row.userId;

  // An agent acts with ITS OWNER's credentials — that is what makes audit
  // attribution correct upstream (ADR 0004).
  if (row.sessionAgentId) return ownerOfAgent(db, row.sessionAgentId);
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
