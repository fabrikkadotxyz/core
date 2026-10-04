/**
 * The native store: outputs held as Yjs documents. Used by `doc` and `latex`.
 *
 * Each open output has a hub in memory that browsers sync with over a WebSocket
 * and that agents' edits are applied to as one more editor — so an agent's change
 * merges with typing in flight instead of racing it. The database holds the
 * encoded state, persisted on a debounce.
 *
 * In-process only, like the event bus: a multi-instance deployment would need
 * a shared Yjs backend behind this same interface. Deliberately not built.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { outputs } from '@fabrikka/db';
import {
  applyAnchoredEdits,
  AttributionTracker,
  deltaToSplices,
  type FlushedBurst,
  lineDiff,
  type Splice,
} from '../output-text.ts';
import { currentRun, writeRows } from './changes.ts';
import type {
  EditRequest,
  EditResult,
  KindContext,
  OutputKindModule,
  OutputRow,
  OutputStore,
  SocketHandlers,
  SyncSocket,
} from './contract.ts';
import { OutputError } from './errors.ts';

/** Human typing becomes one changes-log row after this long idle. */
const BURST_IDLE_MS = 10_000;
const PERSIST_DEBOUNCE_MS = 500;
/** A hub nobody is connected to is unloaded after this long. */
const UNLOAD_AFTER_MS = 30_000;

/** A transaction's origin names who made it — that is the attribution. */
interface Origin {
  participantId: string;
  runId?: string | null;
}

interface Conn {
  /** Null for a viewer (M22), who never originates a transaction. */
  participantId: string | null;
  /** A viewer: sync requests are answered, updates and awareness dropped. */
  readOnly: boolean;
  ws: SyncSocket;
  /** Awareness client ids this socket announced, removed when it closes. */
  clients: Set<number>;
}

interface Hub {
  id: string;
  sessionId: string;
  mainFile: string;
  kind: OutputKindModule;
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
  kindData: Record<string, unknown>;
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const hubs = new Map<string, Hub>();
const loading = new Map<string, Promise<Hub>>();

function files(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>('files');
}

function fileNames(doc: Y.Doc): string[] {
  return [...files(doc).keys()].sort();
}

/**
 * The live hub for a row the caller has already scoped to its session.
 *
 * Loading re-reads the row rather than trusting the caller's copy: a hub that
 * unloaded since the caller read it has persisted newer state.
 */
async function acquire(db: Database, scoped: OutputRow, kind: OutputKindModule): Promise<Hub> {
  const open = hubs.get(scoped.id);
  if (open) return open;
  let pending = loading.get(scoped.id);
  if (!pending) {
    pending = load(db, scoped.id, kind).finally(() => loading.delete(scoped.id));
    loading.set(scoped.id, pending);
  }
  return pending;
}

async function load(db: Database, outputId: string, kind: OutputKindModule): Promise<Hub> {
  const [row] = await db.select().from(outputs).where(eq(outputs.id, outputId)).limit(1);
  if (!row) throw new OutputError('not_found', 'no such output in this session');
  const doc = new Y.Doc();
  if (row.state) Y.applyUpdate(doc, row.state);

  const initial: Record<string, string> = {};
  for (const [name, text] of files(doc)) initial[name] = text.toString();

  const hub: Hub = {
    id: row.id,
    sessionId: row.sessionId,
    mainFile: row.mainFile,
    kind,
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    conns: new Set(),
    tracker: new AttributionTracker(initial),
    version: row.version,
    flushTimer: setInterval(() => {
      void flush(db, hub, hub.tracker.flushIdle(BURST_IDLE_MS));
    }, 2_000),
    runFor: new Map(),
    kindData: (row.kindData as Record<string, unknown> | null) ?? {},
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
      void flush(db, hub, flushed);
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

  hubs.set(row.id, hub);
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

function flush(db: Database, hub: Hub, rows: FlushedBurst[]) {
  return writeRows(
    db,
    {
      outputId: hub.id,
      sessionId: hub.sessionId,
      version: hub.version,
      runFor: (p) => hub.runFor.get(p) ?? null,
    },
    rows,
  );
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
    await flush(db, hub, hub.tracker.flushAll());
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

function contextOf(db: Database, hub: Hub): KindContext {
  return {
    outputId: hub.id,
    sessionId: hub.sessionId,
    get version() {
      return hub.version;
    },
    get viewers() {
      return hub.conns.size;
    },
    files: () => new Map([...files(hub.doc).entries()].map(([path, text]) => [path, text.toString()])),
    get kindData() {
      return hub.kindData;
    },
    async setKindData(patch) {
      hub.kindData = { ...hub.kindData, ...patch };
      await db.update(outputs).set({ kindData: hub.kindData }).where(eq(outputs.id, hub.id));
    },
    edit: (participantId, request, file) => applyEdit(db, hub, { participantId, file: file ?? hub.mainFile, request }),
  };
}

/**
 * Apply an agent's (or any token holder's) edit as one more editor.
 *
 * Runs synchronously against the in-memory document once loaded, so nothing a
 * browser sends can land between the anchor check and the write.
 */
async function applyEdit(
  db: Database,
  hub: Hub,
  opts: { participantId: string; file: string; request: EditRequest },
): Promise<EditResult> {
  const { file, request: req } = opts;
  let text = files(hub.doc).get(file);
  if (!text && req.kind === 'append' && hub.kind.multiFile && hub.kind.files) {
    // Appending to a file that does not exist creates it (docs/protocol.md).
    if (!hub.kind.files.accepts(file)) {
      throw new OutputError('invalid_edit', `"${file}" is not an allowed file name — use ${hub.kind.files.rule}`);
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

  const runId = await currentRun(db, hub.sessionId, opts.participantId);
  const origin: Origin = { participantId: opts.participantId, runId };
  const target = text;
  hub.doc.transact(() => {
    for (const s of splices) {
      if (s.deleteCount) target.delete(s.pos, s.deleteCount);
      if (s.insert) target.insert(s.pos, s.insert);
    }
  }, origin);

  // One row per call: an agent's edit is a unit, not a burst.
  await flush(db, hub, hub.tracker.flushParticipant(opts.participantId));
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

export const yjsStore: OutputStore = {
  initialState(initial) {
    const doc = new Y.Doc();
    doc.transact(() => {
      for (const [file, text] of Object.entries(initial)) {
        const t = new Y.Text();
        t.insert(0, text);
        files(doc).set(file, t);
      }
    });
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return state;
  },

  describe(row) {
    const hub = hubs.get(row.id);
    if (hub) return { files: fileNames(hub.doc), version: hub.version };
    const doc = new Y.Doc();
    if (row.state) Y.applyUpdate(doc, row.state);
    const names = fileNames(doc);
    doc.destroy();
    return { files: names, version: row.version };
  },

  async open(db, row, kind) {
    const hub = await acquire(db, row, kind);
    scheduleUnload(db, hub);
    return contextOf(db, hub);
  },

  async edit(db, row, kind, opts) {
    return applyEdit(db, await acquire(db, row, kind), opts);
  },

  async addFile(db, row, kind, opts) {
    const hub = await acquire(db, row, kind);
    if (files(hub.doc).has(opts.path)) throw new OutputError('invalid_edit', 'that file already exists');
    hub.doc.transact(() => files(hub.doc).set(opts.path, new Y.Text()), {
      participantId: opts.participantId,
    } satisfies Origin);
    await persist(db, hub);
    scheduleUnload(db, hub);
  },

  /** Remove a file. Recorded in the changes log as every line removed. */
  async removeFile(db, row, kind, opts) {
    const hub = await acquire(db, row, kind);
    const text = files(hub.doc).get(opts.path);
    if (!text) throw new OutputError('not_found', 'no such file');
    const before = text.toString();
    hub.doc.transact(() => files(hub.doc).delete(opts.path), {
      participantId: opts.participantId,
    } satisfies Origin);
    // The tracker cannot see a removed file's text change; record it directly.
    if (before) {
      await flush(db, hub, [{ participantId: opts.participantId, file: opts.path, ...lineDiff(opts.path, before, '') }]);
    }
    await persist(db, hub);
    scheduleUnload(db, hub);
  },

  /**
   * Attach a browser. Speaks the standard Yjs sync and awareness protocols, so a
   * stock Yjs client connects. Membership was checked by the caller.
   */
  async attach(db, row, kind, opts): Promise<SocketHandlers> {
    const hub = await acquire(db, row, kind);
    clearTimeout(hub.unloadTimer);

    const conn: Conn = {
      participantId: opts.participantId,
      readOnly: opts.readOnly ?? false,
      ws: opts.ws,
      clients: new Set(),
    };
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
        // Text frames are control messages for the kind (a LaTeX viewer's build report).
        if (typeof data === 'string') {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return;
          }
          void hub.kind.onClientMessage?.(contextOf(db, hub), msg);
          return;
        }
        try {
          const decoder = decoding.createDecoder(new Uint8Array(data));
          const type = decoding.readVarUint(decoder);
          // A viewer may ask for the document (sync step 1) and nothing else: an
          // update or step 2 from them is dropped here, server-side (Threat 8).
          if (conn.readOnly && (type !== MSG_SYNC || decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1)) {
            return;
          }
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
          void flush(db, hub, hub.tracker.flushAll());
          void persist(db, hub);
          scheduleUnload(db, hub);
        }
      },
    };
  },

  evict(outputId) {
    const hub = hubs.get(outputId);
    if (!hub) return;
    for (const c of hub.conns) {
      safeSend(c.ws, JSON.stringify({ type: 'stream.error', code: 'not_found' }));
      c.ws.close();
    }
    dispose(hub);
  },
};
