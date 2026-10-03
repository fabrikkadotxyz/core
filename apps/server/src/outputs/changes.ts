/**
 * The changes log: every edit to every output, attributed. Shared by every
 * store, so attribution works the same whatever holds the content (ADR 0019).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { outputEdits, outputs, participants, runs } from '@fabrikka/db';
import type { OutputEdit, OutputEditSummary } from '@fabrikka/types';
import { publish } from '../bus.ts';
import { linesOf, type FlushedBurst } from '../output-text.ts';

/** Write changes-log rows and announce them. */
export async function writeRows(
  db: Database,
  target: { outputId: string; sessionId: string; version: number; runFor: (participantId: string) => string | null },
  rows: FlushedBurst[],
) {
  if (rows.length === 0) return;
  const [out] = await db
    .select({ name: outputs.name })
    .from(outputs)
    .where(eq(outputs.id, target.outputId))
    .limit(1);
  if (!out) return;

  const people = await db
    .select({ id: participants.id, displayName: participants.displayName, kind: participants.kind })
    .from(participants)
    .where(inArray(participants.id, [...new Set(rows.map((r) => r.participantId))]));
  const byId = new Map(people.map((p) => [p.id, p]));

  for (const r of rows) {
    const runId = target.runFor(r.participantId);
    const [row] = await db
      .insert(outputEdits)
      .values({
        outputId: target.outputId,
        file: r.file,
        participantId: r.participantId,
        runId,
        version: target.version,
        addedLines: r.added,
        removedLines: r.removed,
        diff: r.diff,
      })
      .returning();
    const p = byId.get(r.participantId);
    const lines = linesOf(r.diff);
    // Display data, published to browsers only: an edit is not a message and is
    // not a mention, so it wakes nobody and costs no turn budget (ADR 0019).
    publish(target.sessionId, {
      type: 'output.edited',
      edit: {
        id: row!.id,
        outputId: target.outputId,
        outputName: out.name,
        file: r.file,
        participantId: r.participantId,
        displayName: p?.displayName ?? 'unknown',
        participantKind: (p?.kind as 'human' | 'agent' | undefined) ?? null,
        runId,
        version: target.version,
        added: r.added,
        removed: r.removed,
        lines,
        at: row!.createdAt.toISOString(),
      },
    });
  }
}

/** The run a participant is inside right now, so an agent's edit names it. */
export async function currentRun(db: Database, sessionId: string, participantId: string) {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.sessionId, sessionId), eq(runs.participantId, participantId), eq(runs.status, 'running')),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return run?.id ?? null;
}

export async function listEdits(
  db: Database,
  sessionId: string,
  opts: { outputId?: string; agentsOnly?: boolean; limit?: number } = {},
): Promise<OutputEdit[]> {
  const rows = await db
    .select({
      e: outputEdits,
      outputName: outputs.name,
      displayName: participants.displayName,
      kind: participants.kind,
    })
    .from(outputEdits)
    .innerJoin(outputs, eq(outputs.id, outputEdits.outputId))
    .leftJoin(participants, eq(participants.id, outputEdits.participantId))
    .where(
      and(
        eq(outputs.sessionId, sessionId),
        opts.outputId ? eq(outputEdits.outputId, opts.outputId) : undefined,
        opts.agentsOnly ? eq(participants.kind, 'agent') : undefined,
      ),
    )
    .orderBy(desc(outputEdits.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));

  return rows.map(({ e, outputName, displayName, kind }) => ({
    id: e.id,
    outputId: e.outputId,
    outputName,
    file: e.file,
    participantId: e.participantId,
    displayName: displayName ?? e.externalAuthor ?? 'someone',
    participantKind: (kind as OutputEditSummary['participantKind']) ?? null,
    runId: e.runId,
    version: e.version,
    added: e.addedLines,
    removed: e.removedLines,
    lines: linesOf(e.diff),
    at: e.createdAt.toISOString(),
    diff: e.diff,
  }));
}
