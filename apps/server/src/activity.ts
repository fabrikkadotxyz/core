/**
 * Runs and their live activity.
 *
 * Activity is **ephemeral**: events live in a capped in-memory buffer per run and
 * are discarded when it ends. Hundreds of rows per run, for something nobody
 * re-reads later, is not worth storing — the run's *outcome* is a durable message.
 * See ADR 0015.
 *
 * It is also **inert**: activity never reaches another agent as context and never
 * counts against the turn budget. It is display data, and must not become an
 * injection path between agents.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { participants, runs, sessionAgents } from '@fabrikka/db';
import type { ActivityEvent, Run, RunKind, RunStatus } from '@fabrikka/types';
import { publish } from './bus.ts';

/** Enough to catch a late joiner up; short enough to bound memory. */
const BUFFER_PER_RUN = 200;

/** runId -> recent events. Cleared when the run ends. */
const buffers = new Map<string, ActivityEvent[]>();

/** A run must belong to the participant claiming it, or it is ignored. */
async function ownRun(
  db: Database,
  sessionId: string,
  participantId: string,
  runId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.sessionId, sessionId),
        eq(runs.participantId, participantId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Whether this agent's steps may be shown.
 *
 * Off means the run itself is still visible — presence and the outcome — but the
 * steps are not. Someone working in a private repo inside a shared session gets to
 * decline without leaving the session.
 */
export async function activityVisible(
  db: Database,
  participantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ visible: sessionAgents.activityVisible })
    .from(participants)
    .innerJoin(sessionAgents, eq(sessionAgents.id, participants.sessionAgentId))
    .where(eq(participants.id, participantId))
    .limit(1);
  // A human participant has no agent row; there is nothing to stream either way.
  return row?.visible ?? false;
}

export async function startRun(
  db: Database,
  opts: {
    runId: string;
    sessionId: string;
    participantId: string;
    kind: RunKind;
    provider?: string | null;
    triggerMessageId?: string | null;
  },
): Promise<Run | null> {
  const [participant] = await db
    .select({ displayName: participants.displayName })
    .from(participants)
    .where(
      and(eq(participants.id, opts.participantId), eq(participants.sessionId, opts.sessionId)),
    )
    .limit(1);
  if (!participant) return null;

  const [row] = await db
    .insert(runs)
    .values({
      id: opts.runId,
      sessionId: opts.sessionId,
      participantId: opts.participantId,
      kind: opts.kind,
      provider: opts.provider ?? null,
      triggerMessageId: opts.triggerMessageId ?? null,
      status: 'running',
    })
    // A reconnecting runner may resend; the first claim stands.
    .onConflictDoNothing()
    .returning();

  if (!row) return null;

  const run = toRun(row, participant.displayName);
  buffers.set(run.id, []);
  publish(opts.sessionId, { type: 'run.started', run });
  return run;
}

export async function endRun(
  db: Database,
  opts: {
    runId: string;
    sessionId: string;
    participantId: string;
    status: RunStatus;
  },
): Promise<void> {
  if (!(await ownRun(db, opts.sessionId, opts.participantId, opts.runId))) return;

  const [row] = await db
    .update(runs)
    .set({ status: opts.status, endedAt: new Date() })
    .where(and(eq(runs.id, opts.runId), isNull(runs.endedAt)))
    .returning();

  // The buffer goes regardless: the run is over, and its outcome is a message.
  buffers.delete(opts.runId);
  if (!row) return;

  const [participant] = await db
    .select({ displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.id, opts.participantId))
    .limit(1);

  publish(opts.sessionId, {
    type: 'run.ended',
    run: toRun(row, participant?.displayName ?? 'unknown'),
  });
}

/**
 * Record one step and fan it out.
 *
 * `detail` arrived already redacted from the runner (ADR 0015) — this end of the
 * wire never sees a raw argument, so there is nothing further to strip. It is
 * length-capped anyway, because trusting a client's self-restraint about size is
 * how a buffer becomes a memory leak.
 */
export async function recordActivity(
  db: Database,
  opts: {
    runId: string;
    sessionId: string;
    participantId: string;
    tool: string;
    detail: string | null;
  },
): Promise<void> {
  if (!(await ownRun(db, opts.sessionId, opts.participantId, opts.runId))) return;
  if (!(await activityVisible(db, opts.participantId))) return;

  const [participant] = await db
    .select({ displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.id, opts.participantId))
    .limit(1);
  if (!participant) return;

  const event: ActivityEvent = {
    runId: opts.runId,
    participantId: opts.participantId,
    displayName: participant.displayName,
    tool: opts.tool.slice(0, 64),
    detail: opts.detail ? opts.detail.slice(0, 120) : null,
    at: new Date().toISOString(),
  };

  const buffer = buffers.get(opts.runId) ?? [];
  buffer.push(event);
  // Oldest out first: a late joiner wants the recent steps, not the first ones.
  if (buffer.length > BUFFER_PER_RUN) buffer.shift();
  buffers.set(opts.runId, buffer);

  publish(opts.sessionId, { type: 'activity', event });
}

/** In-flight runs plus their buffered steps, so a late joiner catches up. */
export async function catchUp(
  db: Database,
  sessionId: string,
): Promise<{ runs: Run[]; activity: ActivityEvent[] }> {
  const rows = await db
    .select({ run: runs, displayName: participants.displayName })
    .from(runs)
    .innerJoin(participants, eq(participants.id, runs.participantId))
    .where(and(eq(runs.sessionId, sessionId), isNull(runs.endedAt)))
    .orderBy(desc(runs.startedAt))
    .limit(10);

  const live = rows.map((r) => toRun(r.run, r.displayName));
  const activity = live.flatMap((r) => buffers.get(r.id) ?? []);

  return { runs: live, activity };
}

/** Stop tracking a session's runs, e.g. when it is deleted. */
export function forgetSession(runIds: string[]): void {
  for (const id of runIds) buffers.delete(id);
}

function toRun(row: typeof runs.$inferSelect, displayName: string): Run {
  return {
    id: row.id,
    participantId: row.participantId,
    displayName,
    kind: row.kind as RunKind,
    provider: row.provider,
    status: row.status as RunStatus,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

