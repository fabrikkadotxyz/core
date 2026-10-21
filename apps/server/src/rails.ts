/**
 * Safety rails: the turn budget and the kill switch.
 *
 * Both answer "make it stop", and both live on the SERVER, because since ADR 0011
 * the process doing the work is on the user's machine. The server can always stop
 * *sending*; it can only *ask* a runner to stop what is already running. Those are
 * different guarantees and are kept distinct here and in the UI.
 *
 * See docs/decisions/0012-halt-is-server-side-termination-is-cooperative.md.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { sessionTurnBudget, sessions } from '@fabrikka/db';
import { publish } from './bus.ts';

/** 20 deliveries per 10 minutes, per session. */
export const TURN_LIMIT = 20;
export const WINDOW_MS = 10 * 60 * 1000;

export type PauseReason = 'manual' | 'turn_budget';

export interface PauseState {
  paused: boolean;
  reason: PauseReason | null;
  pausedAt: string | null;
  /** Deliveries used in the current window. */
  turnsUsed: number;
  turnLimit: number;
}

export async function pauseState(
  db: Database,
  sessionId: string,
): Promise<PauseState> {
  const [[session], [budget]] = await Promise.all([
    db
      .select({
        pausedAt: sessions.agentsPausedAt,
        reason: sessions.agentsPausedReason,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1),
    db.select().from(sessionTurnBudget).where(eq(sessionTurnBudget.sessionId, sessionId)).limit(1),
  ]);

  const fresh = !budget || Date.now() - budget.windowStart.getTime() >= WINDOW_MS;

  return {
    paused: !!session?.pausedAt,
    reason: (session?.reason as PauseReason | null) ?? null,
    pausedAt: session?.pausedAt?.toISOString() ?? null,
    turnsUsed: fresh ? 0 : budget.agentTurnsUsed,
    turnLimit: TURN_LIMIT,
  };
}

export async function setPaused(
  db: Database,
  sessionId: string,
  paused: boolean,
  reason: PauseReason = 'manual',
): Promise<void> {
  await db
    .update(sessions)
    .set({
      agentsPausedAt: paused ? new Date() : null,
      agentsPausedReason: paused ? reason : null,
    })
    .where(eq(sessions.id, sessionId));

  // Resuming starts a fresh window, so a human is not immediately re-paused by
  // the same exhausted budget they just cleared.
  if (!paused) {
    await db
      .update(sessionTurnBudget)
      .set({ windowStart: new Date(), agentTurnsUsed: 0 })
      .where(eq(sessionTurnBudget.sessionId, sessionId));
  }

  publish(sessionId, {
    type: 'agents.paused',
    paused,
    reason: paused ? reason : null,
  });
}

export type BudgetVerdict =
  | { allowed: true; turnsUsed: number }
  | { allowed: false; reason: 'paused' | 'turn_budget'; pauseReason: PauseReason | null };

/**
 * Claim one delivery against the budget.
 *
 * Called once per agent about to be delivered to, immediately before delivery.
 * Exhausting the budget pauses the session, which is the same state a human
 * reaches with the kill switch — one mechanism, one way to resume.
 */
export async function claimTurn(
  db: Database,
  sessionId: string,
): Promise<BudgetVerdict> {
  const [session] = await db
    .select({
      pausedAt: sessions.agentsPausedAt,
      reason: sessions.agentsPausedReason,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (session?.pausedAt) {
    return {
      allowed: false,
      reason: 'paused',
      pauseReason: (session.reason as PauseReason | null) ?? 'manual',
    };
  }

  const now = new Date();
  // ISO strings with an explicit cast: a raw Date interpolated into sql`` is
  // handed to the driver unserialized and throws at bind time.
  const nowIso = now.toISOString();
  const floorIso = new Date(now.getTime() - WINDOW_MS).toISOString();

  // A single statement so concurrent deliveries cannot both read "19 used" and
  // both proceed. The window resets in the same write when it has aged out.
  const [row] = await db
    .insert(sessionTurnBudget)
    .values({ sessionId, windowStart: now, agentTurnsUsed: 1 })
    .onConflictDoUpdate({
      target: sessionTurnBudget.sessionId,
      set: {
        windowStart: sql`case when ${sessionTurnBudget.windowStart} < ${floorIso}::timestamptz
          then ${nowIso}::timestamptz else ${sessionTurnBudget.windowStart} end`,
        agentTurnsUsed: sql`case when ${sessionTurnBudget.windowStart} < ${floorIso}::timestamptz
          then 1 else ${sessionTurnBudget.agentTurnsUsed} + 1 end`,
      },
    })
    .returning({ used: sessionTurnBudget.agentTurnsUsed });

  const used = row?.used ?? 1;

  if (used > TURN_LIMIT) {
    await setPaused(db, sessionId, true, 'turn_budget');
    return { allowed: false, reason: 'turn_budget', pauseReason: 'turn_budget' };
  }

  return { allowed: true, turnsUsed: used };
}

/* -------------------------------------------------------------------------- */
/* Aborting in-flight work                                                    */
/* -------------------------------------------------------------------------- */

type AbortListener = () => void;

const abortListeners = new Map<string, Set<AbortListener>>();

/** A connection registers here so a pause can ask it to stop what it is doing. */
export function onAbort(sessionId: string, fn: AbortListener): () => void {
  let set = abortListeners.get(sessionId);
  if (!set) {
    set = new Set();
    abortListeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) abortListeners.delete(sessionId);
  };
}

/**
 * Ask every connection in a session to abort in-flight work.
 *
 * A REQUEST, not a guarantee. A runner that is wedged, offline or modified will
 * not comply, and a live channel turn cannot be recalled at all — the model is
 * already mid-turn in the user's own terminal. The UI says so.
 */
export function broadcastAbort(sessionId: string): number {
  const set = abortListeners.get(sessionId);
  if (!set) return 0;
  for (const fn of set) {
    try {
      fn();
    } catch (err) {
      console.error('[rails] abort listener threw', err);
    }
  }
  return set.size;
}
