/**
 * Outputs: live documents the whole session edits. See ADR 0019.
 *
 * Native kinds are Yjs documents. Each open output has a hub in memory that
 * browsers sync with over a WebSocket and that agents' edits are applied to as
 * one more editor — so an agent's change merges with typing in flight instead of
 * racing it. The database holds the encoded state, persisted on a debounce.
 *
 * In-process only, like the event bus: a multi-instance deployment would need
 * a shared Yjs backend behind this same interface. Deliberately not built.
 */
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { outputEdits, outputs, participants, runs } from '@fabrikka/db';
import type {
  BuildError,
  BuildReport,
  Output,
  OutputEdit,
  OutputEditSummary,
  OutputKind,
  OutputKindInfo,
} from '@fabrikka/types';
import { publish } from './bus.ts';
import { texAvailable } from './tex.ts';
import {
  applyAnchoredEdits,
  AttributionTracker,
  deltaToSplices,
  type AnchoredEdit,
  type FlushedBurst,
  lineDiff,
  linesOf,
  type Splice,
} from './output-text.ts';

/** Human typing becomes one changes-log row after this long idle. */
const BURST_IDLE_MS = 10_000;
const PERSIST_DEBOUNCE_MS = 500;
/** A hub nobody is connected to is unloaded after this long. */
const UNLOAD_AFTER_MS = 30_000;
const MAX_NAME = 120;

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

interface KindDef {
  info: Omit<OutputKindInfo, 'available'>;
  available: () => boolean;
  mainFile: string;
  template: (name: string) => Record<string, string>;
}

/**
 * The kinds this instance offers. Built-in only: a third-party kind is code that
 * would run beside credentials, and loading one safely is not designed yet.
 */
const KINDS: Record<string, KindDef> = {
  doc: {
    info: {
      kind: 'doc',
      name: 'Document',
      description: 'Write together in real time. Headings, lists, links — Markdown underneath.',
      multiFile: false,
    },
    available: () => true,
    mainFile: 'document.md',
    // Empty: the name is the title, and a heading copied from it would go stale
    // the first time someone renamed the document.
    template: () => ({ 'document.md': '' }),
  },
  latex: {
    info: {
      kind: 'latex',
      name: 'LaTeX paper',
      description: 'A paper with a live PDF beside it. Compiled in your browser; citations included.',
      multiFile: true,
    },
    // Absent, not broken, on an instance without the TeX assets (ADR 0020).
    available: texAvailable,
    mainFile: 'main.tex',
    // A working paper, so the first thing anyone sees is a PDF, not an error.
    template: (name) => ({
      'main.tex': [
        '\\documentclass{article}',
        '\\usepackage{amsmath}',
        '\\usepackage{graphicx}',
        '\\usepackage{hyperref}',
        '',
        `\\title{${texSafe(name)}}`,
        '\\author{}',
        '\\date{\\today}',
        '',
        '\\begin{document}',
        '\\maketitle',
        '',
        '\\section{Introduction}',
        'Start writing here. Cite sources from \\texttt{refs.bib} like this~\\cite{knuth1984}.',
        '',
        '\\bibliographystyle{plain}',
        '\\bibliography{refs}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
      'refs.bib': [
        '@article{knuth1984,',
        '  author  = {Donald E. Knuth},',
        '  title   = {Literate Programming},',
        '  journal = {The Computer Journal},',
        '  volume  = {27},',
        '  number  = {2},',
        '  pages   = {97--111},',
        '  year    = {1984}',
        '}',
        '',
      ].join('\n'),
    }),
  },
};

/** Text files a multi-file output may hold. Images come from artifacts. */
const FILE_PATH =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){0,3}[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tex|bib|sty|cls|bst|txt)$/;

export function isValidFilePath(path: string): boolean {
  return FILE_PATH.test(path) && !path.includes('..') && path.length <= 120;
}

export function outputKinds(): OutputKindInfo[] {
  return Object.values(KINDS).map((k) => ({ ...k.info, available: k.available() }));
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type OutputErrorCode =
  | 'not_found'
  | 'anchor_not_found'
  | 'anchor_ambiguous'
  | 'version_moved'
  | 'invalid_edit';

export class OutputError extends Error {
  constructor(
    readonly code: OutputErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* Hubs                                                                       */
/* -------------------------------------------------------------------------- */

/** What a sync socket needs from the server's WebSocket. */
export interface SyncSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

/** A transaction's origin names who made it — that is the attribution. */
interface Origin {
  participantId: string;
  runId?: string | null;
}

interface Conn extends Origin {
  ws: SyncSocket;
  /** Awareness client ids this socket announced, removed when it closes. */
  clients: Set<number>;
}

interface Hub {
  id: string;
  sessionId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<Conn>;
  tracker: AttributionTracker;
  version: number;
  persistTimer?: ReturnType<typeof setTimeout>;
  unloadTimer?: ReturnType<typeof setTimeout>;
  flushTimer: ReturnType<typeof setInterval>;
  /** Runs per participant, for agent rows. */
  runFor: Map<string, string | null>;
  kind: string;
  /** latex: the latest accepted build report. */
  build: Omit<BuildReport, 'viewers'> | null;
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const hubs = new Map<string, Hub>();
const loading = new Map<string, Promise<Hub | null>>();

function files(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>('files');
}

function fileNames(doc: Y.Doc): string[] {
  return [...files(doc).keys()].sort();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is "no such output", not a database error. */
export function isOutputId(id: string): boolean {
  return UUID.test(id);
}

async function acquire(db: Database, sessionId: string, outputId: string): Promise<Hub | null> {
  if (!isOutputId(outputId)) return null;
  const open = hubs.get(outputId);
  if (open) return open.sessionId === sessionId ? open : null;

  let pending = loading.get(outputId);
  if (!pending) {
    pending = load(db, outputId).finally(() => loading.delete(outputId));
    loading.set(outputId, pending);
  }
  const hub = await pending;
  // Scoped by session as well as id: an output id is opaque, not a capability.
  return hub && hub.sessionId === sessionId ? hub : null;
}

async function load(db: Database, outputId: string): Promise<Hub | null> {
  const [row] = await db.select().from(outputs).where(eq(outputs.id, outputId)).limit(1);
  if (!row) return null;

  const doc = new Y.Doc();
  if (row.state) Y.applyUpdate(doc, row.state);

  const initial: Record<string, string> = {};
  for (const [name, text] of files(doc)) initial[name] = text.toString();

  const hub: Hub = {
    id: row.id,
    sessionId: row.sessionId,
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    conns: new Set(),
    tracker: new AttributionTracker(initial),
    version: row.version,
    flushTimer: setInterval(() => {
      void writeRows(db, hub, hub.tracker.flushIdle(BURST_IDLE_MS));
    }, 2_000),
    runFor: new Map(),
    kind: row.kind,
    build: (row.build as Hub['build']) ?? null,
  };
  // The server holds no awareness state of its own; only browsers have cursors.
  hub.awareness.setLocalState(null);

  const observe = (name: string, text: Y.Text) =>
    text.observe((event, tr) => {
      const origin = tr.origin as Origin | null;
      // Loading persisted state has no origin and is not an edit.
      if (!origin?.participantId) return;
      const flushed = hub.tracker.record(name, origin.participantId, deltaToSplices(event.delta as never));
      if (origin.runId !== undefined) hub.runFor.set(origin.participantId, origin.runId);
      void writeRows(db, hub, flushed);
    });
  for (const [name, text] of files(doc)) observe(name, text);
  files(doc).observe((event) => {
    for (const key of event.keysChanged) {
      const text = files(doc).get(key);
      if (text) observe(key, text);
    }
  });

  doc.on('afterTransaction', (tr) => {
    if (!tr.changed.size || !(tr.origin as Origin | null)?.participantId) return;
    hub.version++;
    schedulePersist(db, hub);
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    for (const c of hub.conns) if (c !== origin) safeSend(c.ws, msg);
  });

  hub.awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changed = [...added, ...updated, ...removed];
      const conn = origin as Conn | null;
      if (conn?.clients) {
        for (const id of added) conn.clients.add(id);
        for (const id of removed) conn.clients.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(hub.awareness, changed),
      );
      const msg = encoding.toUint8Array(encoder);
      for (const c of hub.conns) safeSend(c.ws, msg);
    },
  );

  hubs.set(outputId, hub);
  scheduleUnload(db, hub);
  return hub;
}

function safeSend(ws: SyncSocket, data: string | Uint8Array) {
  try {
    ws.send(data);
  } catch {
    // A socket closing mid-send is cleaned up by its close handler.
  }
}

function schedulePersist(db: Database, hub: Hub) {
  clearTimeout(hub.persistTimer);
  hub.persistTimer = setTimeout(() => void persist(db, hub), PERSIST_DEBOUNCE_MS);
}

async function persist(db: Database, hub: Hub) {
  clearTimeout(hub.persistTimer);
  hub.persistTimer = undefined;
  await db
    .update(outputs)
    .set({ state: Y.encodeStateAsUpdate(hub.doc), version: hub.version, updatedAt: new Date() })
    .where(eq(outputs.id, hub.id));
}

function scheduleUnload(db: Database, hub: Hub) {
  clearTimeout(hub.unloadTimer);
  hub.unloadTimer = setTimeout(async () => {
    if (hub.conns.size > 0) return;
    await writeRows(db, hub, hub.tracker.flushAll());
    await persist(db, hub);
    if (hub.conns.size > 0) return;
    dispose(hub);
  }, UNLOAD_AFTER_MS);
}

function dispose(hub: Hub) {
  clearInterval(hub.flushTimer);
  clearTimeout(hub.persistTimer);
  clearTimeout(hub.unloadTimer);
  hub.awareness.destroy();
  hub.doc.destroy();
  hubs.delete(hub.id);
}

/* -------------------------------------------------------------------------- */
/* The changes log                                                            */
/* -------------------------------------------------------------------------- */

async function writeRows(db: Database, hub: Hub, rows: FlushedBurst[]) {
  if (rows.length === 0) return;
  const [out] = await db
    .select({ name: outputs.name })
    .from(outputs)
    .where(eq(outputs.id, hub.id))
    .limit(1);
  if (!out) return;

  const people = await db
    .select({ id: participants.id, displayName: participants.displayName, kind: participants.kind })
    .from(participants)
    .where(inArray(participants.id, [...new Set(rows.map((r) => r.participantId))]));
  const byId = new Map(people.map((p) => [p.id, p]));

  for (const r of rows) {
    const runId = hub.runFor.get(r.participantId) ?? null;
    const [row] = await db
      .insert(outputEdits)
      .values({
        outputId: hub.id,
        file: r.file,
        participantId: r.participantId,
        runId,
        version: hub.version,
        addedLines: r.added,
        removedLines: r.removed,
        diff: r.diff,
      })
      .returning();
    const p = byId.get(r.participantId);
    const lines = linesOf(r.diff);
    // Display data, published to browsers only: an edit is not a message and is
    // not a mention, so it wakes nobody and costs no turn budget (ADR 0019).
    publish(hub.sessionId, {
      type: 'output.edited',
      edit: {
        id: row!.id,
        outputId: hub.id,
        outputName: out.name,
        file: r.file,
        participantId: r.participantId,
        displayName: p?.displayName ?? 'unknown',
        participantKind: (p?.kind as 'human' | 'agent' | undefined) ?? null,
        runId,
        version: hub.version,
        added: r.added,
        removed: r.removed,
        lines,
        at: row!.createdAt.toISOString(),
      },
    });
  }
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
    const [last] = await db
      .select({ at: outputEdits.createdAt, displayName: participants.displayName })
      .from(outputEdits)
      .leftJoin(participants, eq(participants.id, outputEdits.participantId))
      .where(eq(outputEdits.outputId, o.id))
      .orderBy(desc(outputEdits.createdAt))
      .limit(1);

    const hub = hubs.get(o.id);
    let names: string[];
    if (hub) names = fileNames(hub.doc);
    else {
      const doc = new Y.Doc();
      if (o.state) Y.applyUpdate(doc, o.state);
      names = fileNames(doc);
      doc.destroy();
    }

    result.push({
      id: o.id,
      kind: o.kind as OutputKind,
      name: o.name,
      files: names,
      mainFile: o.mainFile,
      version: hub?.version ?? o.version,
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
  const def = KINDS[opts.kind];
  if (!def || !def.available()) {
    const offered = outputKinds().filter((k) => k.available).map((k) => k.kind);
    throw new OutputError('invalid_edit', `unknown kind "${opts.kind}" — this instance offers: ${offered.join(', ')}`);
  }
  const name = opts.name.trim().slice(0, MAX_NAME);
  if (!name) throw new OutputError('invalid_edit', 'a name is required');

  const doc = new Y.Doc();
  const initial = def.template(name);
  if (opts.content !== undefined) initial[def.mainFile] = opts.content;
  doc.transact(() => {
    for (const [file, text] of Object.entries(initial)) {
      const t = new Y.Text();
      t.insert(0, text);
      files(doc).set(file, t);
    }
  });

  const [row] = await db
    .insert(outputs)
    .values({
      sessionId: opts.sessionId,
      kind: opts.kind,
      name,
      mainFile: def.mainFile,
      state: Y.encodeStateAsUpdate(doc),
      createdByParticipantId: opts.participantId,
    })
    .returning();
  doc.destroy();

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
  if (!isOutputId(outputId)) return false;
  const trimmed = name.trim().slice(0, MAX_NAME);
  if (!trimmed) return false;
  const [before] = await db
    .select({ name: outputs.name, kind: outputs.kind })
    .from(outputs)
    .where(and(eq(outputs.id, outputId), eq(outputs.sessionId, sessionId)))
    .limit(1);
  if (!before) return false;
  await db.update(outputs).set({ name: trimmed }).where(eq(outputs.id, outputId));

  // A paper whose \title is still the old name follows the rename, so the PDF
  // does not keep saying "Untitled paper". Only an exact match: a title someone
  // has written themselves is theirs, not the document name's.
  if (before.kind === 'latex' && before.name !== trimmed) {
    await editOutput(db, {
      sessionId,
      outputId,
      participantId,
      request: {
        kind: 'edits',
        edits: [{ old_text: `\\title{${texSafe(before.name)}}`, new_text: `\\title{${texSafe(trimmed)}}` }],
      },
    }).catch(() => {});
  }
  publish(sessionId, { type: 'output.changed', outputId });
  return true;
}

/** A document name as a LaTeX title: drop the characters TeX would choke on. */
function texSafe(name: string): string {
  return name.replace(/[\\{}$&#^_%~]/g, '');
}

/** Remove an output. The caller decides who may (creator or owner). */
export async function deleteOutput(db: Database, sessionId: string, outputId: string) {
  if (!isOutputId(outputId)) return false;
  const hub = hubs.get(outputId);
  if (hub && hub.sessionId === sessionId) {
    for (const c of hub.conns) {
      safeSend(c.ws, JSON.stringify({ type: 'stream.error', code: 'not_found' }));
      c.ws.close();
    }
    dispose(hub);
  }
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
  content: string;
  version: number;
  totalLines: number;
  startLine: number;
  build: BuildReport | null;
}

export async function readOutput(
  db: Database,
  sessionId: string,
  outputId: string,
  opts: { file?: string; startLine?: number; maxLines?: number } = {},
): Promise<ReadResult> {
  const hub = await acquire(db, sessionId, outputId);
  const output = hub && (await getOutput(db, sessionId, outputId));
  if (!hub || !output) throw new OutputError('not_found', 'no such output in this session');
  scheduleUnload(db, hub);

  const file = opts.file ?? output.mainFile;
  const text = files(hub.doc).get(file);
  if (!text) {
    throw new OutputError('not_found', `no file "${file}" — files are: ${output.files.join(', ')}`);
  }

  const lines = text.toString().split('\n');
  const start = Math.max(1, opts.startLine ?? 1);
  const max = Math.max(1, opts.maxLines ?? 2000);
  return {
    output,
    file,
    content: lines.slice(start - 1, start - 1 + max).join('\n'),
    version: hub.version,
    totalLines: lines.length,
    startLine: start,
    build: buildFor(hub),
  };
}

/**
 * A report counts only for the version it was made against. Anything else is
 * "unknown" — never "passed" (ADR 0020).
 */
function buildFor(hub: Hub): BuildReport | null {
  if (hub.kind !== 'latex') return null;
  const viewers = hub.conns.size;
  if (hub.build && hub.build.version === hub.version) return { ...hub.build, viewers };
  return { status: 'unknown', version: null, at: null, errors: [], viewers };
}

/** What a browser hashes to say what it compiled. See docs/protocol.md. */
function sourceHash(doc: Y.Doc): string {
  const pairs = [...files(doc).entries()]
    .map(([path, text]) => [path, text.toString()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

async function acceptBuildReport(db: Database, hub: Hub, msg: Record<string, unknown>) {
  if (hub.kind !== 'latex') return;
  // Stale — someone typed since this browser compiled. Dropped, not mislabelled.
  if (typeof msg.sourceHash !== 'string' || msg.sourceHash !== sourceHash(hub.doc)) return;
  if (msg.status !== 'ok' && msg.status !== 'failed') return;
  const errors: BuildError[] = (Array.isArray(msg.errors) ? msg.errors : [])
    .slice(0, 20)
    .map((e: Record<string, unknown>) => ({
      file: String(e?.file ?? '').slice(0, 120),
      line: typeof e?.line === 'number' && Number.isFinite(e.line) ? Math.trunc(e.line) : null,
      message: String(e?.message ?? '').slice(0, 300),
    }));
  hub.build = { status: msg.status, version: hub.version, at: new Date().toISOString(), errors };
  await db.update(outputs).set({ build: hub.build }).where(eq(outputs.id, hub.id));
}

export type EditRequest =
  | { kind: 'edits'; edits: AnchoredEdit[] }
  | { kind: 'append'; text: string }
  | { kind: 'replace'; content: string; ifVersion: number };

/**
 * Apply an agent's (or any token holder's) edit as one more editor.
 *
 * Runs synchronously against the in-memory document once loaded, so nothing a
 * browser sends can land between the anchor check and the write.
 */
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
  const hub = await acquire(db, opts.sessionId, opts.outputId);
  if (!hub) throw new OutputError('not_found', 'no such output in this session');

  const [row] = await db
    .select({ mainFile: outputs.mainFile })
    .from(outputs)
    .where(eq(outputs.id, opts.outputId))
    .limit(1);
  const file = opts.file ?? row!.mainFile;
  let text = files(hub.doc).get(file);
  if (!text && opts.request.kind === 'append' && KINDS[hub.kind]?.info.multiFile) {
    // Appending to a file that does not exist creates it (docs/protocol.md).
    if (!isValidFilePath(file)) {
      throw new OutputError(
        'invalid_edit',
        `"${file}" is not an allowed file name — use a relative path ending in .tex, .bib, .sty, .cls, .bst or .txt`,
      );
    }
    text = new Y.Text();
    const created = text;
    hub.doc.transact(() => files(hub.doc).set(file, created), {
      participantId: opts.participantId,
    } satisfies Origin);
  }
  if (!text) throw new OutputError('not_found', `no file "${file}" in this output`);

  // Synchronous from here: the check and the write cannot be interleaved.
  const current = text.toString();
  let splices: Splice[];
  const req = opts.request;
  if (req.kind === 'edits') {
    const r = applyAnchoredEdits(current, req.edits);
    if (!r.ok) throw new OutputError(r.code, r.message);
    splices = r.splices;
  } else if (req.kind === 'append') {
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    splices = [{ pos: current.length, deleteCount: 0, insert: sep + req.text }];
  } else {
    if (req.ifVersion !== hub.version) {
      throw new OutputError(
        'version_moved',
        `the output is at version ${hub.version}, not ${req.ifVersion} — someone changed it. ` +
          'Re-read, and prefer edits over replacing the whole file.',
      );
    }
    splices = [minimalSplice(current, req.content)];
  }

  const runId = await currentRun(db, opts.sessionId, opts.participantId);
  const origin: Origin = { participantId: opts.participantId, runId };
  const target = text;
  hub.doc.transact(() => {
    for (const s of splices) {
      if (s.deleteCount) target.delete(s.pos, s.deleteCount);
      if (s.insert) target.insert(s.pos, s.insert);
    }
  }, origin);

  // One row per call: an agent's edit is a unit, not a burst.
  await writeRows(db, hub, hub.tracker.flushParticipant(opts.participantId));
  await persist(db, hub);
  scheduleUnload(db, hub);
  return { version: hub.version, applied: splices.length, file };
}

/** Replace only what differs, so concurrent cursors elsewhere stay put. */
function minimalSplice(before: string, after: string): Splice {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return { pos: start, deleteCount: endB - start, insert: after.slice(start, endA) };
}

async function currentRun(db: Database, sessionId: string, participantId: string) {
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

/* ---- files, for multi-file kinds (the browser's file strip) ---- */

export async function addFile(
  db: Database,
  opts: { sessionId: string; outputId: string; participantId: string; path: string },
) {
  const hub = await acquire(db, opts.sessionId, opts.outputId);
  if (!hub) throw new OutputError('not_found', 'no such output in this session');
  if (!KINDS[hub.kind]?.info.multiFile) throw new OutputError('invalid_edit', 'this kind has one file');
  if (!isValidFilePath(opts.path)) {
    throw new OutputError('invalid_edit', 'use a name like section.tex or refs.bib');
  }
  if (files(hub.doc).has(opts.path)) throw new OutputError('invalid_edit', 'that file already exists');
  hub.doc.transact(() => files(hub.doc).set(opts.path, new Y.Text()), {
    participantId: opts.participantId,
  } satisfies Origin);
  await persist(db, hub);
  scheduleUnload(db, hub);
  publish(opts.sessionId, { type: 'output.changed', outputId: opts.outputId });
}

/** Remove a file. Recorded in the changes log as every line removed. */
export async function removeFile(
  db: Database,
  opts: { sessionId: string; outputId: string; participantId: string; path: string },
) {
  const hub = await acquire(db, opts.sessionId, opts.outputId);
  if (!hub) throw new OutputError('not_found', 'no such output in this session');
  const [row] = await db.select({ mainFile: outputs.mainFile }).from(outputs).where(eq(outputs.id, hub.id));
  if (opts.path === row?.mainFile) throw new OutputError('invalid_edit', 'the main file cannot be removed');
  const text = files(hub.doc).get(opts.path);
  if (!text) throw new OutputError('not_found', 'no such file');
  const before = text.toString();
  hub.doc.transact(() => files(hub.doc).delete(opts.path), {
    participantId: opts.participantId,
  } satisfies Origin);
  // The tracker cannot see a removed file's text change; record it directly.
  if (before) {
    await writeRows(db, hub, [
      { participantId: opts.participantId, file: opts.path, ...lineDiff(opts.path, before, '') },
    ]);
  }
  await persist(db, hub);
  scheduleUnload(db, hub);
  publish(opts.sessionId, { type: 'output.changed', outputId: opts.outputId });
}

/* -------------------------------------------------------------------------- */
/* The sync socket                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Attach a browser. Speaks the standard Yjs sync and awareness protocols, so a
 * stock Yjs client connects. Membership was checked by the caller.
 */
export async function attachSocket(
  db: Database,
  opts: { sessionId: string; outputId: string; participantId: string; ws: SyncSocket },
): Promise<{ onMessage: (data: ArrayBuffer | string) => void; onClose: () => void } | null> {
  const hub = await acquire(db, opts.sessionId, opts.outputId);
  if (!hub) return null;
  clearTimeout(hub.unloadTimer);

  const conn: Conn = { participantId: opts.participantId, ws: opts.ws, clients: new Set() };
  hub.conns.add(conn);

  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, hub.doc);
    safeSend(opts.ws, encoding.toUint8Array(encoder));
  }
  const states = [...hub.awareness.getStates().keys()];
  if (states.length) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(hub.awareness, states));
    safeSend(opts.ws, encoding.toUint8Array(encoder));
  }

  return {
    onMessage(data) {
      // Text frames are control messages: a LaTeX viewer's build report.
      if (typeof data === 'string') {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === 'build.report') void acceptBuildReport(db, hub, msg);
        return;
      }
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, hub.doc, conn);
          if (encoding.length(encoder) > 1) safeSend(opts.ws, encoding.toUint8Array(encoder));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            hub.awareness,
            decoding.readVarUint8Array(decoder),
            conn,
          );
        }
      } catch (err) {
        console.error('[outputs] bad sync frame:', (err as Error).message);
      }
    },
    onClose() {
      if (!hub.conns.delete(conn)) return;
      awarenessProtocol.removeAwarenessStates(hub.awareness, [...conn.clients], null);
      if (hub.conns.size === 0) {
        // The last viewer left: record what they typed now, not in ten seconds.
        void writeRows(db, hub, hub.tracker.flushAll());
        void persist(db, hub);
        scheduleUnload(db, hub);
      }
    },
  };
}
