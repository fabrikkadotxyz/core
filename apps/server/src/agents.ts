/**
 * Agent identity, session tokens, and trust evaluation.
 *
 * `Claude Code` is a provider; `@claude-fede` is a participant. An `agents` row
 * is the middle term — a named identity owned by a user, addable to any number
 * of sessions. See ARCHITECTURE.md and ADR 0009.
 */
import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  agents,
  generateToken,
  hashToken,
  participants,
  sessionAgents,
  sessionTokens,
  sessions,
  users,
} from '@fabrikka/db';
import type { AgentSummary, TrustTier } from '@fabrikka/types';
import { isActiveUser } from './leaving.ts';

export type AgentTrustPolicy = 'owner_only' | 'session_trusted';

/**
 * Who a token speaks as.
 *
 * Resolved before the MCP handler runs and carried as `authInfo`, so tool code
 * never re-derives identity from the request.
 */
export interface TokenActor {
  tokenId: string;
  sessionId: string;
  sessionPublicId: string;
  ownerSlug: string;
  participantId: string;
  participantName: string;
  participantKind: 'human' | 'agent';
  /** Present when the participant is an agent. */
  agent?: {
    id: string;
    provider: string;
    ownerUserId: string;
    trustTier: AgentTrustPolicy;
  };
}

/**
 * Resolve a bearer token to an actor.
 *
 * Returns null for unknown, revoked and expired tokens alike — the caller maps
 * every one of those to 404 so a wrong token cannot distinguish a real session
 * from an imaginary one (ADR 0009).
 */
export async function resolveSessionToken(
  db: Database,
  token: string,
): Promise<TokenActor | null> {
  const rows = await db
    .select({
      tokenId: sessionTokens.id,
      expiresAt: sessionTokens.expiresAt,
      sessionId: sessions.id,
      sessionPublicId: sessions.publicId,
      ownerSlug: users.ownerSlug,
      participantId: participants.id,
      participantName: participants.displayName,
      participantKind: participants.kind,
      sessionAgentId: sessionAgents.id,
      trustTier: sessionAgents.trustTier,
      agentId: agents.id,
      agentProvider: agents.provider,
      agentOwnerId: agents.ownerId,
      participantUserId: participants.userId,
    })
    .from(sessionTokens)
    .innerJoin(sessions, eq(sessions.id, sessionTokens.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .innerJoin(participants, eq(participants.id, sessionTokens.participantId))
    // An agent participant carries these; a human token leaves them null.
    .leftJoin(sessionAgents, eq(sessionAgents.id, participants.sessionAgentId))
    .leftJoin(agents, eq(agents.id, sessionAgents.agentId))
    .where(
      and(
        eq(sessionTokens.tokenHash, hashToken(token)),
        isNull(sessionTokens.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  // M58 (ADR 0057): a deactivated or deleted person acts through nothing, their agents included.
  const actor = row.agentOwnerId ?? row.participantUserId;
  if (actor && !(await isActiveUser(db, actor))) return null;

  // Fire-and-forget: a failed liveness write must not fail the request.
  void db
    .update(sessionTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessionTokens.id, row.tokenId))
    .catch(() => {});

  return {
    tokenId: row.tokenId,
    sessionId: row.sessionId,
    sessionPublicId: row.sessionPublicId,
    ownerSlug: row.ownerSlug,
    participantId: row.participantId,
    participantName: row.participantName,
    participantKind: row.participantKind as 'human' | 'agent',
    agent:
      row.agentId && row.agentOwnerId
        ? {
            id: row.agentId,
            provider: row.agentProvider ?? 'other',
            ownerUserId: row.agentOwnerId,
            trustTier: (row.trustTier ?? 'owner_only') as AgentTrustPolicy,
          }
        : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Adding an agent to a session                                               */
/* -------------------------------------------------------------------------- */

export interface CreatedAgent {
  agent: AgentSummary;
  /** Plaintext token. Returned exactly once and never recoverable. */
  token: string;
  /** The endpoint to give the agent, with the owner segment already filled in. */
  mcpUrl: string;
}

/**
 * Create an agent identity, add it to a session as a participant, and issue its
 * first token — one operation, because an agent with no participant row or no
 * token is not usable and should not be representable.
 */
export async function addAgentToSession(
  db: Database,
  opts: {
    sessionId: string;
    ownerUserId: string;
    displayName: string;
    provider: string;
    label?: string;
    publicUrl: string;
    ownerSlug: string;
    sessionPublicId: string;
  },
): Promise<{ ok: true; created: CreatedAgent } | { ok: false; error: string }> {
  const displayName = opts.displayName.trim();
  // Display names are resolved from prose by mention matching, so they have to
  // be valid handles (ADR 0008).
  if (!/^[A-Za-z0-9._-]+$/.test(displayName)) {
    return {
      ok: false,
      error: 'agent name may contain only letters, digits, dot, hyphen and underscore',
    };
  }

  const [clash] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.sessionId, opts.sessionId),
        eq(participants.displayName, displayName),
      ),
    )
    .limit(1);
  if (clash) return { ok: false, error: 'that name is already taken in this session' };

  const token = generateToken();

  const created = await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        ownerId: opts.ownerUserId,
        provider: opts.provider,
        name: displayName,
      })
      .returning();

    const [sa] = await tx
      .insert(sessionAgents)
      .values({ sessionId: opts.sessionId, agentId: agent!.id })
      .returning();

    const [participant] = await tx
      .insert(participants)
      .values({
        sessionId: opts.sessionId,
        kind: 'agent',
        sessionAgentId: sa!.id,
        displayName,
      })
      .returning();

    await tx.insert(sessionTokens).values({
      sessionId: opts.sessionId,
      participantId: participant!.id,
      tokenHash: hashToken(token),
      label: opts.label?.trim() || `${displayName} token`,
      createdByUserId: opts.ownerUserId,
    });

    return { agent: agent!, sa: sa!, participant: participant! };
  });

  return {
    ok: true,
    created: {
      token,
      mcpUrl: `${opts.publicUrl}/mcp/o/${opts.ownerSlug}/s/${opts.sessionPublicId}`,
      agent: {
        participantId: created.participant.id,
        sessionAgentId: created.sa.id,
        displayName: created.participant.displayName,
        provider: created.agent.provider,
        trustTier: created.sa.trustTier as AgentTrustPolicy,
        activityVisible: created.sa.activityVisible,
        ownerUserId: created.agent.ownerId,
      },
    },
  };
}

export async function listSessionAgents(
  db: Database,
  sessionId: string,
): Promise<AgentSummary[]> {
  const rows = await db
    .select({
      participantId: participants.id,
      sessionAgentId: sessionAgents.id,
      displayName: participants.displayName,
      provider: agents.provider,
      trustTier: sessionAgents.trustTier,
      activityVisible: sessionAgents.activityVisible,
      ownerUserId: agents.ownerId,
    })
    .from(sessionAgents)
    .innerJoin(agents, eq(agents.id, sessionAgents.agentId))
    .innerJoin(participants, eq(participants.sessionAgentId, sessionAgents.id))
    .where(eq(sessionAgents.sessionId, sessionId))
    .orderBy(asc(participants.displayName));

  return rows.map((r) => ({
    participantId: r.participantId,
    sessionAgentId: r.sessionAgentId,
    displayName: r.displayName,
    provider: r.provider,
    trustTier: r.trustTier as AgentTrustPolicy,
    activityVisible: r.activityVisible,
    ownerUserId: r.ownerUserId,
  }));
}

export async function setAgentTrustTier(
  db: Database,
  sessionId: string,
  sessionAgentId: string,
  trustTier: AgentTrustPolicy,
): Promise<boolean> {
  const updated = await db
    .update(sessionAgents)
    .set({ trustTier })
    .where(
      and(eq(sessionAgents.id, sessionAgentId), eq(sessionAgents.sessionId, sessionId)),
    )
    .returning({ id: sessionAgents.id });
  return updated.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

export interface TokenSummary {
  id: string;
  participantId: string;
  participantName: string;
  label: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function listSessionTokens(
  db: Database,
  sessionId: string,
): Promise<TokenSummary[]> {
  const rows = await db
    .select({
      id: sessionTokens.id,
      participantId: sessionTokens.participantId,
      participantName: participants.displayName,
      label: sessionTokens.label,
      lastUsedAt: sessionTokens.lastUsedAt,
      expiresAt: sessionTokens.expiresAt,
      createdAt: sessionTokens.createdAt,
    })
    .from(sessionTokens)
    .innerJoin(participants, eq(participants.id, sessionTokens.participantId))
    // Exclude expired ones: short-lived run tokens (ADR 0011) would otherwise
    // accumulate in the UI as dead rows a human has to mentally filter out.
    .where(
      and(
        eq(sessionTokens.sessionId, sessionId),
        isNull(sessionTokens.revokedAt),
        or(isNull(sessionTokens.expiresAt), gt(sessionTokens.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(sessionTokens.createdAt));

  return rows.map((r) => ({
    id: r.id,
    participantId: r.participantId,
    participantName: r.participantName,
    label: r.label,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Issue an additional token for an existing participant. */
export async function issueToken(
  db: Database,
  opts: {
    sessionId: string;
    participantId: string;
    createdByUserId: string;
    label?: string;
  },
): Promise<string | null> {
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.id, opts.participantId),
        eq(participants.sessionId, opts.sessionId),
      ),
    )
    .limit(1);
  if (!participant) return null;

  const token = generateToken();
  await db.insert(sessionTokens).values({
    sessionId: opts.sessionId,
    participantId: opts.participantId,
    tokenHash: hashToken(token),
    label: opts.label?.trim() || null,
    createdByUserId: opts.createdByUserId,
  });
  return token;
}

export async function revokeToken(
  db: Database,
  sessionId: string,
  tokenId: string,
): Promise<boolean> {
  const updated = await db
    .update(sessionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessionTokens.id, tokenId),
        eq(sessionTokens.sessionId, sessionId),
        isNull(sessionTokens.revokedAt),
      ),
    )
    .returning({ id: sessionTokens.id });
  return updated.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Trust                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How much authority a message's author has over the reading actor.
 *
 * Evaluated per reader: the same message is `owner` to the agent its author owns
 * and `untrusted` to every other agent in the room. M3 reports this honestly;
 * M6 enforces it. See docs/security.md.
 */
export function trustOf(
  reader: TokenActor,
  author: { participantId: string; userId: string | null },
): TrustTier {
  // Its own messages. Agents are excluded from their own mentions at M6, but the
  // label should still be truthful.
  if (author.participantId === reader.participantId) return 'owner';

  // A human token reads as that human: everything else is another participant.
  if (!reader.agent) return 'untrusted';

  if (author.userId && author.userId === reader.agent.ownerUserId) return 'owner';
  if (reader.agent.trustTier === 'session_trusted') return 'session';
  return 'untrusted';
}


/**
 * A token for exactly one spawned run.
 *
 * Same session and participant as the runner that asked for it, short TTL, and
 * revoked when the run ends. A spawned agent's config path is visible to the
 * model and its transcript may be logged, so a long-lived token in that position
 * is a standing liability. See ADR 0011.
 */
const RUN_TOKEN_TTL_MS = 30 * 60 * 1000;

export async function issueRunToken(
  db: Database,
  opts: { sessionId: string; participantId: string; createdByUserId: string },
): Promise<{ token: string; tokenId: string; expiresAt: string } | null> {
  if (!opts.createdByUserId) return null;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + RUN_TOKEN_TTL_MS);

  const [row] = await db
    .insert(sessionTokens)
    .values({
      sessionId: opts.sessionId,
      participantId: opts.participantId,
      tokenHash: hashToken(token),
      label: 'spawned run',
      createdByUserId: opts.createdByUserId,
      expiresAt,
    })
    .returning({ id: sessionTokens.id });

  return { token, tokenId: row!.id, expiresAt: expiresAt.toISOString() };
}

/**
 * Revoke a token belonging to a specific participant.
 *
 * Scoped to the participant, not just the session: holding one agent's runner
 * credential must not let you revoke another agent's access.
 */
export async function revokeOwnToken(
  db: Database,
  opts: { sessionId: string; participantId: string; tokenId: string },
): Promise<boolean> {
  const updated = await db
    .update(sessionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessionTokens.id, opts.tokenId),
        eq(sessionTokens.sessionId, opts.sessionId),
        eq(sessionTokens.participantId, opts.participantId),
        isNull(sessionTokens.revokedAt),
      ),
    )
    .returning({ id: sessionTokens.id });
  return updated.length > 0;
}

/**
 * Toggle whether an agent's steps stream to the session.
 *
 * Caller must already have established that they own the agent — this function
 * enforces session scope, not authorship.
 */
export async function setActivityVisible(
  db: Database,
  sessionId: string,
  sessionAgentId: string,
  visible: boolean,
): Promise<boolean> {
  const updated = await db
    .update(sessionAgents)
    .set({ activityVisible: visible })
    .where(
      and(eq(sessionAgents.id, sessionAgentId), eq(sessionAgents.sessionId, sessionId)),
    )
    .returning({ id: sessionAgents.id });
  return updated.length > 0;
}
