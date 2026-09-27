/**
 * Mention delivery to agents.
 *
 * **The server decides what an agent may act on — never the bridge.** A channel
 * push starts a turn, and the bridge runs on the user's machine as a process they
 * can edit, so a gate enforced there is not a gate. A modified bridge gains
 * nothing: it can only receive what the server was already willing to send.
 *
 * See docs/decisions/0010-bridge-proxies-and-gates-at-source.md.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { agentConnections, agents, participants, sessionAgents } from '@fabrikka/db';
import type { Message, TrustTier } from '@fabrikka/types';
import { publish } from './bus.ts';
import { renderMentions } from './mentions.ts';
import { listParticipantsWithUsers } from './sessions.ts';

export type BlockReason = 'own_message' | 'not_trusted' | 'no_connection';

export interface Delivery {
  participantId: string;
  displayName: string;
  trust: TrustTier;
}

export interface Blocked {
  participantId: string;
  displayName: string;
  reason: BlockReason;
  trust: TrustTier;
}

/** Callbacks a transport registers to receive pushes for one participant. */
type Listener = (delivery: { message: Message; trust: TrustTier }) => void;

const listeners = new Map<string, Set<Listener>>();

/** Returns an unsubscribe function. */
export function listenForMentions(participantId: string, fn: Listener): () => void {
  let set = listeners.get(participantId);
  if (!set) {
    set = new Set();
    listeners.set(participantId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(participantId);
  };
}

export function hasLiveBridge(participantId: string): boolean {
  return (listeners.get(participantId)?.size ?? 0) > 0;
}

/**
 * Evaluate and deliver a newly-posted message to every agent it mentions.
 *
 * Returns what was delivered and what was blocked, so callers can report both.
 * A blocked mention is NOT silently dropped: a `mention.blocked` event goes to the
 * browser, because silent non-delivery is indistinguishable from a bug.
 */
export async function deliverMentions(
  db: Database,
  sessionId: string,
  message: Message,
): Promise<{ delivered: Delivery[]; blocked: Blocked[] }> {
  const mentionedAgents = message.mentions.filter((m) => m.kind === 'agent');
  if (mentionedAgents.length === 0) return { delivered: [], blocked: [] };

  const all = await listParticipantsWithUsers(db, sessionId);
  const author = all.find((p) => p.id === message.author.participantId);

  // Expand `<@id>` markers before pushing. The server owns every projection of
  // stored content (ADR 0008/0010) — a bridge should never see internal ids, and
  // a model reading "<@2e0f2cbf-…>" cannot tell who was addressed.
  const delivered_message: Message = {
    ...message,
    content: renderMentions(message.content, all),
  };

  const delivered: Delivery[] = [];
  const blocked: Blocked[] = [];

  for (const mention of mentionedAgents) {
    const policy = await agentPolicy(db, sessionId, mention.participantId);
    if (!policy) continue;

    const trust = trustFor(policy, {
      participantId: message.author.participantId,
      userId: author?.userId ?? null,
    });

    // An agent never acts on its own words. Cheapest possible loop guard, and
    // it is correct regardless of trust.
    if (message.author.participantId === mention.participantId) {
      blocked.push({ ...describe(mention), reason: 'own_message', trust });
      continue;
    }

    // owner_only is the default: only the agent's owner can direct it. An
    // untrusted mention never starts a turn (docs/security.md).
    if (trust === 'untrusted') {
      blocked.push({ ...describe(mention), reason: 'not_trusted', trust });
      continue;
    }

    const set = listeners.get(mention.participantId);
    if (!set || set.size === 0) {
      // Nothing is listening. At M5 this is where the spawn path picks it up.
      blocked.push({ ...describe(mention), reason: 'no_connection', trust });
      continue;
    }

    for (const fn of set) {
      try {
        fn({ message: delivered_message, trust });
      } catch (err) {
        console.error('[delivery] listener threw', err);
      }
    }
    delivered.push({ ...describe(mention), trust });
  }

  for (const b of blocked) {
    publish(sessionId, {
      type: 'mention.blocked',
      messageId: message.id,
      participantId: b.participantId,
      displayName: b.displayName,
      reason: b.reason,
    });
  }

  return { delivered, blocked };
}

function describe(mention: { participantId: string; displayName: string }) {
  return { participantId: mention.participantId, displayName: mention.displayName };
}

interface AgentPolicy {
  participantId: string;
  ownerUserId: string;
  trustTier: 'owner_only' | 'session_trusted';
}

async function agentPolicy(
  db: Database,
  sessionId: string,
  participantId: string,
): Promise<AgentPolicy | null> {
  // The owning user lives on `agents`, not on the session link, so the join has
  // to go all the way through. Getting this wrong makes an owner's own mentions
  // evaluate as untrusted and silently stop being delivered.
  const rows = await db
    .select({
      participantId: participants.id,
      trustTier: sessionAgents.trustTier,
      ownerUserId: agents.ownerId,
    })
    .from(participants)
    .innerJoin(sessionAgents, eq(sessionAgents.id, participants.sessionAgentId))
    .innerJoin(agents, eq(agents.id, sessionAgents.agentId))
    .where(
      and(eq(participants.id, participantId), eq(participants.sessionId, sessionId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    participantId: row.participantId,
    ownerUserId: row.ownerUserId,
    trustTier: row.trustTier as AgentPolicy['trustTier'],
  };
}

/** Trust of a message's author, from the perspective of a receiving agent. */
function trustFor(
  policy: AgentPolicy,
  author: { participantId: string; userId: string | null },
): TrustTier {
  if (author.participantId === policy.participantId) return 'owner';
  if (author.userId && author.userId === policy.ownerUserId) return 'owner';
  if (policy.trustTier === 'session_trusted') return 'session';
  return 'untrusted';
}

/* -------------------------------------------------------------------------- */
/* Presence                                                                   */
/* -------------------------------------------------------------------------- */

export async function setConnectionStatus(
  db: Database,
  opts: {
    sessionId: string;
    participantId: string;
    kind: 'bridge' | 'remote_http';
    status: 'connected' | 'working' | 'idle' | 'offline';
  },
): Promise<void> {
  const fields = {
    sessionId: opts.sessionId,
    kind: opts.kind,
    status: opts.status,
    lastSeenAt: new Date(),
  };

  await db
    .insert(agentConnections)
    .values({ participantId: opts.participantId, ...fields })
    .onConflictDoUpdate({ target: agentConnections.participantId, set: fields });

  publish(opts.sessionId, {
    type: 'presence.updated',
    participantId: opts.participantId,
    status: opts.status,
  });
}

export async function connectionStatuses(
  db: Database,
  sessionId: string,
): Promise<Map<string, 'connected' | 'working' | 'idle' | 'offline'>> {
  const rows = await db
    .select({
      participantId: agentConnections.participantId,
      status: agentConnections.status,
    })
    .from(agentConnections)
    .where(eq(agentConnections.sessionId, sessionId));

  return new Map(
    rows.map((r) => [
      r.participantId,
      r.status as 'connected' | 'working' | 'idle' | 'offline',
    ]),
  );
}
