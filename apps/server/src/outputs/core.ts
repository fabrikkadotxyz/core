/**
 * Outputs: live documents the whole session edits. See ADR 0019.
 *
 * This is the kind-agnostic core: the catalogue, the outputs table, and routing
 * each call to the kind and store that own the output. It names no kind — every
 * kind lives in `kinds/<id>/` and is listed in `registry.ts` (ADR 0023).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Database } from '@fabrikka/db';
import { outputEdits, outputs, participants } from '@fabrikka/db';
import type { Output, OutputKindInfo } from '@fabrikka/types';
import { publish } from '../bus.ts';
import type { EditRequest, OutputKindModule, OutputRow, Resolvers, SocketHandlers, SyncSocket } from './contract.ts';
import { OutputError } from './errors.ts';
import { KINDS } from './registry.ts';

export { OutputError, type OutputErrorCode } from './errors.ts';
export type { EditRequest, SyncSocket } from './contract.ts';
export { listEdits } from './changes.ts';

const MAX_NAME = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const byId = new Map(KINDS.map((k) => [k.id, k]));

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

export function outputKinds(): OutputKindInfo[] {
  return KINDS.map((k) => ({
    kind: k.id,
    name: k.name,
    description: k.description,
    icon: k.icon,
    defaultName: k.defaultName,
    multiFile: k.multiFile,
    available: k.available(),
  }));
}

/** One sentence per kind that has something to tell agents about editing it. */
export function agentHints(): string[] {
  return KINDS.filter((k) => k.available() && k.agentHint).map((k) => k.agentHint!);
}

/** Ids of the multi-file kinds on offer, for tool descriptions. */
export function multiFileKinds(): string[] {
  return KINDS.filter((k) => k.available() && k.multiFile).map((k) => k.id);
}

/** Mount every kind's own HTTP routes. Called once, at startup. */
export function mountKindRoutes(app: Hono<any>, sessionRoutes: Hono<any>, resolve: Resolvers) {
  for (const k of KINDS) {
    k.routes?.public?.(app);
    k.routes?.session?.(sessionRoutes, resolve);
  }
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/** A malformed id is "no such output", not a database error. */
export function isOutputId(id: string): boolean {
  return UUID.test(id);
}

/**
 * The row and its kind, scoped by session as well as id: an output id is opaque,
 * not a capability. A row whose kind is no longer registered is "not found".
 */
async function find(db: Database, sessionId: string, outputId: string): Promise<{ row: OutputRow; kind: OutputKindModule } | null> {
  if (!isOutputId(outputId)) return null;
  const [row] = await db
    .select()
    .from(outputs)
    .where(and(eq(outputs.id, outputId), eq(outputs.sessionId, sessionId)))
    .limit(1);
  const kind = row && byId.get(row.kind);
  return row && kind ? { row, kind } : null;
}

async function mustFind(db: Database, sessionId: string, outputId: string) {
  const found = await find(db, sessionId, outputId);
  if (!found) throw new OutputError('not_found', 'no such output in this session');
  return found;
}

/* -------------------------------------------------------------------------- */
/* Queries and commands                                                       */
/* -------------------------------------------------------------------------- */

export async function listOutputs(db: Database, sessionId: string): Promise<Output[]> {
  const rows = await db
    .select({ o: outputs, authorName: participants.displayName })
    .from(outputs)
    .innerJoin(participants, eq(participants.id, outputs.createdByParticipantId))
    .where(eq(outputs.sessionId, sessionId))
    .orderBy(desc(outputs.updatedAt));

  const result: Output[] = [];
  for (const { o, authorName } of rows) {
    const kind = byId.get(o.kind);
    if (!kind) continue;
    const [last] = await db
      .select({ at: outputEdits.createdAt, displayName: participants.displayName })
      .from(outputEdits)
      .leftJoin(participants, eq(participants.id, outputEdits.participantId))
      .where(eq(outputEdits.outputId, o.id))
      .orderBy(desc(outputEdits.createdAt))
      .limit(1);

    const { files, version } = kind.store.describe(o);
    result.push({
      id: o.id,
      kind: o.kind,
      name: o.name,
      files,
      mainFile: o.mainFile,
      version,
      createdBy: { participantId: o.createdByParticipantId, displayName: authorName },
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      lastEdit: last
        ? { displayName: last.displayName ?? 'someone', at: last.at.toISOString() }
        : null,
    });
  }
  return result;
}

export async function getOutput(
  db: Database,
  sessionId: string,
  outputId: string,
): Promise<Output | null> {
  return (await listOutputs(db, sessionId)).find((o) => o.id === outputId) ?? null;
}

export async function createOutput(
  db: Database,
  opts: { sessionId: string; participantId: string; kind: string; name: string; content?: string },
): Promise<Output> {
  const kind = byId.get(opts.kind);
  if (!kind || !kind.available()) {
    const offered = outputKinds().filter((k) => k.available).map((k) => k.kind);
    throw new OutputError('invalid_edit', `unknown kind "${opts.kind}" — this instance offers: ${offered.join(', ')}`);
  }
  const name = opts.name.trim().slice(0, MAX_NAME);
  if (!name) throw new OutputError('invalid_edit', 'a name is required');

  const initial = kind.template(name);
  if (opts.content !== undefined) initial[kind.mainFile] = opts.content;

  const [row] = await db
    .insert(outputs)
    .values({
      sessionId: opts.sessionId,
      kind: kind.id,
      name,
      mainFile: kind.mainFile,
      state: kind.store.initialState(initial),
      createdByParticipantId: opts.participantId,
    })
    .returning();

  publish(opts.sessionId, { type: 'output.changed', outputId: row!.id });
  return (await getOutput(db, opts.sessionId, row!.id))!;
}

export async function renameOutput(
  db: Database,
  sessionId: string,
  outputId: string,
  name: string,
  participantId: string,
): Promise<boolean> {
  const trimmed = name.trim().slice(0, MAX_NAME);
  if (!trimmed) return false;
  const found = await find(db, sessionId, outputId);
  if (!found) return false;
  const before = found.row.name;
  await db.update(outputs).set({ name: trimmed }).where(eq(outputs.id, outputId));

  if (before !== trimmed && found.kind.onRenamed) {
    const ctx = await found.kind.store.open(db, found.row, found.kind);
    await found.kind.onRenamed(ctx, { before, after: trimmed, participantId }).catch(() => {});
  }
  publish(sessionId, { type: 'output.changed', outputId });
  return true;
}

/** Remove an output. The caller decides who may (creator or owner). */
export async function deleteOutput(db: Database, sessionId: string, outputId: string) {
  const found = await find(db, sessionId, outputId);
  if (found) found.kind.store.evict(outputId);
  if (!isOutputId(outputId)) return false;
  const done = await db
    .delete(outputs)
    .where(and(eq(outputs.id, outputId), eq(outputs.sessionId, sessionId)))
    .returning({ id: outputs.id });
  if (done.length) publish(sessionId, { type: 'output.changed', outputId });
  return done.length > 0;
}

export async function outputCreator(db: Database, sessionId: string, outputId: string) {
  if (!isOutputId(outputId)) return null;
  const [row] = await db
    .select({ createdBy: outputs.createdByParticipantId })
    .from(outputs)
    .where(and(eq(outputs.id, outputId), eq(outputs.sessionId, sessionId)))
    .limit(1);
  return row?.createdBy ?? null;
}

export interface ReadResult {
  output: Output;
  file: string;
  format: string;
  content: string;
  version: number;
  totalLines: number;
  startLine: number;
  /** Kind-specific fields for `read_output` (latex's `build`). */
  extras: Record<string, unknown>;
}

export async function readOutput(
  db: Database,
  sessionId: string,
  outputId: string,
  opts: { file?: string; startLine?: number; maxLines?: number } = {},
): Promise<ReadResult> {
  const { row, kind } = await mustFind(db, sessionId, outputId);
  const ctx = await kind.store.open(db, row, kind);
  const output = await getOutput(db, sessionId, outputId);
  if (!output) throw new OutputError('not_found', 'no such output in this session');

  const file = opts.file ?? output.mainFile;
  const text = ctx.files().get(file);
  if (text === undefined) {
    throw new OutputError('not_found', `no file "${file}" — files are: ${output.files.join(', ')}`);
  }

  const lines = text.split('\n');
  const start = Math.max(1, opts.startLine ?? 1);
  const max = Math.max(1, opts.maxLines ?? 2000);
  return {
    output,
    file,
    format: kind.format,
    content: lines.slice(start - 1, start - 1 + max).join('\n'),
    version: ctx.version,
    totalLines: lines.length,
    startLine: start,
    extras: kind.readExtras?.(ctx) ?? {},
  };
}

/** Apply an agent's (or any token holder's) edit as one more editor. */
export async function editOutput(
  db: Database,
  opts: {
    sessionId: string;
    outputId: string;
    participantId: string;
    file?: string;
    request: EditRequest;
  },
): Promise<{ version: number; applied: number; file: string }> {
  const { row, kind } = await mustFind(db, opts.sessionId, opts.outputId);
  return kind.store.edit(db, row, kind, {
    participantId: opts.participantId,
    file: opts.file ?? row.mainFile,
    request: opts.request,
  });
}

/* ---- files, for multi-file kinds (the browser's file strip) ---- */

export async function addFile(
  db: Database,
  opts: { sessionId: string; outputId: string; participantId: string; path: string },
) {
  const { row, kind } = await mustFind(db, opts.sessionId, opts.outputId);
  if (!kind.multiFile || !kind.files) throw new OutputError('invalid_edit', 'this kind has one file');
  if (!kind.files.accepts(opts.path)) {
    throw new OutputError('invalid_edit', `use a name like ${kind.files.example}`);
  }
  await kind.store.addFile(db, row, kind, { participantId: opts.participantId, path: opts.path });
  publish(opts.sessionId, { type: 'output.changed', outputId: opts.outputId });
}

/** Remove a file. Recorded in the changes log as every line removed. */
export async function removeFile(
  db: Database,
  opts: { sessionId: string; outputId: string; participantId: string; path: string },
) {
  const { row, kind } = await mustFind(db, opts.sessionId, opts.outputId);
  if (opts.path === row.mainFile) throw new OutputError('invalid_edit', 'the main file cannot be removed');
  await kind.store.removeFile(db, row, kind, { participantId: opts.participantId, path: opts.path });
  publish(opts.sessionId, { type: 'output.changed', outputId: opts.outputId });
}

/* ---- the viewer socket ---- */

/** Attach a browser to an output. Membership was checked by the caller. */
export async function attachSocket(
  db: Database,
  opts: { sessionId: string; outputId: string; participantId: string | null; ws: SyncSocket; readOnly?: boolean },
): Promise<SocketHandlers | null> {
  const found = await find(db, opts.sessionId, opts.outputId);
  if (!found) return null;
  return found.kind.store.attach(db, found.row, found.kind, {
    participantId: opts.participantId,
    ws: opts.ws,
    readOnly: opts.readOnly,
  });
}
