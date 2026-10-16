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
import { claimTurn } from './rails.ts';
import { renderMentions } from './mentions.ts';
import { listParticipantsWithUsers } from './sessions.ts';

export type BlockReason =
  | 'own_message'
  | 'not_trusted'
  | 'no_connection'
  | 'paused'
  | 'turn_budget';

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

/** How a connection wants to act on a mention. */
export type ConnectionKind = 'bridge' | 'runner';

/** Callbacks a transport registers to receive pushes for one participant. */
type Listener = (delivery: { message: Message; trust: TrustTier }) => void;

interface Registration {
  kind: ConnectionKind;
  fn: Listener;
}

const listeners = new Map<string, Set<Registration>>();

/** Returns an unsubscribe function. */
export function listenForMentions(
  participantId: string,
  kind: ConnectionKind,
  fn: Listener,
): () => void {
  let set = listeners.get(participantId);
  if (!set) {
    set = new Set();
    listeners.set(participantId, set);
  }
  const registration: Registration = { kind, fn };
  set.add(registration);
  return () => {
    set!.delete(registration);
    if (set!.size === 0) listeners.delete(participantId);
  };
}

/**
 * Pick who gets the mention.
 *
 * A live `bridge` wins over a `runner`: pushing into a session that already holds
 * the user's context and repo beats starting a fresh headless agent. Only when no
 * bridge is attached does the spawn path get it. See ADR 0011.
 */
function chooseTargets(participantId: string): Registration[] {
  const set = listeners.get(participantId);
  if (!set || set.size === 0) return [];

  const bridges = [...set].filter((r) => r.kind === 'bridge');
  return bridges.length > 0 ? bridges : [...set];
}

export function hasLiveConnection(participantId: string): boolean {
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

    const targets = chooseTargets(mention.participantId);
    if (targets.length === 0) {
      // Neither a live session nor a runner. Nothing to do but say so.
      blocked.push({ ...describe(mention), reason: 'no_connection', trust });
      continue;
    }

    // Claimed per agent about to be delivered to, immediately before delivery —
    // so the count matches what actually causes an agent to act, and a paused
    // session stops here rather than somewhere downstream (ADR 0012).
    const verdict = await claimTurn(db, sessionId);
    if (!verdict.allowed) {
      blocked.push({
        ...describe(mention),
        reason: verdict.reason === 'paused' ? 'paused' : 'turn_budget',
        trust,
      });
      continue;
    }

    for (const target of targets) {
      try {
        target.fn({ message: delivered_message, trust });
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
    kind: ConnectionKind | 'remote_http';
    status: 'connected' | 'working' | 'blocked' | 'idle' | 'offline';
    /** M15 slice 1: with `blocked`, why and on what (already redacted, capped here). */
    reason?: string | null;
    detail?: string | null;
    /** M15 slice 1: with `idle`, a unit of work just finished. */
    completed?: boolean;
  },
): Promise<void> {
  const blocked = opts.status === 'blocked';
  const fields = {
    sessionId: opts.sessionId,
    kind: opts.kind,
    status: opts.status,
    blockedReason: blocked ? (opts.reason ?? null)?.slice(0, 32) ?? null : null,
    blockedDetail: blocked ? (opts.detail ?? null)?.slice(0, 120) ?? null : null,
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
    ...(blocked ? { reason: fields.blockedReason as never, detail: fields.blockedDetail } : {}),
    ...(opts.status === 'idle' && opts.completed ? { completed: true } : {}),
  });
}

export async function connectionStatuses(
  db: Database,
  sessionId: string,
): Promise<Map<string, 'connected' | 'working' | 'blocked' | 'idle' | 'offline'>> {
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
      r.status as 'connected' | 'working' | 'blocked' | 'idle' | 'offline',
    ]),
  );
}

/** M15 slice 1: what a blocked agent is waiting on, for the room and the home. */
export async function blockedOn(db: Database, sessionId: string): Promise<Map<string, { reason: string | null; detail: string | null }>> {
  const rows = await db
    .select({ participantId: agentConnections.participantId, reason: agentConnections.blockedReason, detail: agentConnections.blockedDetail })
    .from(agentConnections)
    .where(and(eq(agentConnections.sessionId, sessionId), eq(agentConnections.status, 'blocked')));
  return new Map(rows.map((r) => [r.participantId, { reason: r.reason, detail: r.detail }]));
}
