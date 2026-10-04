/**
 * The browser end of an output's sync socket. See docs/protocol.md.
 *
 * Standard Yjs sync and awareness protocols. Written here rather than taken from
 * y-websocket because the server refuses in-band — a JSON text frame, then close
 * (same as the session stream) — and a client that does not read that frame
 * reconnects forever against a socket that will never accept it.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { SessionRef } from '../api.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'refused';

export interface OutputSync {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Send a JSON control frame (used by LaTeX build reports). */
  sendControl(msg: unknown): void;
  destroy(): void;
}

export function connectOutput(
  ref: SessionRef,
  outputId: string,
  me: { name: string; color: string },
  onStatus: (s: SyncStatus) => void,
): OutputSync {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField('user', { name: me.name, color: me.color, colorLight: `${me.color}33` });

  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const send = (bytes: Uint8Array) => {
    // lib0 types its buffers loosely; they are always plain ArrayBuffers.
    if (ws?.readyState === WebSocket.OPEN) ws.send(bytes as Uint8Array<ArrayBuffer>);
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    send(encoding.toUint8Array(e));
  };
  doc.on('update', onDocUpdate);

  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'remote') return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      e,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
    );
    send(encoding.toUint8Array(e));
  };
  awareness.on('update', onAwareness);

  const open = () => {
    if (stopped) return;
    onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${proto}://${location.host}/api/o/${ref.owner}/s/${ref.session}/outputs/${outputId}/sync`,
    );
    socket.binaryType = 'arraybuffer';
    ws = socket;
    let refused = false;

    socket.onopen = () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, doc);
      send(encoding.toUint8Array(e));
      if (awareness.getLocalState()) {
        const a = encoding.createEncoder();
        encoding.writeVarUint(a, MSG_AWARENESS);
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
        send(encoding.toUint8Array(a));
      }
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data) as { type?: string };
        if (msg.type === 'stream.error') {
          // Refused: do NOT reconnect. See docs/protocol.md.
          refused = true;
          onStatus('refused');
        }
        return;
      }
      const d = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
      const type = decoding.readVarUint(d);
      if (type === MSG_SYNC) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(d, e, doc, 'remote');
        if (kind === syncProtocol.messageYjsSyncStep2) {
          attempt = 0;
          onStatus('synced');
        }
        if (encoding.length(e) > 1) send(encoding.toUint8Array(e));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), 'remote');
      }
    };

    socket.onclose = () => {
      if (stopped || refused) return;
      // Other people's cursors are stale the moment we lose them.
      awarenessProtocol.removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter((id) => id !== doc.clientID),
        'remote',
      );
      onStatus('offline');
      retry = setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
    };
  };

  open();

  return {
    doc,
    awareness,
    sendControl(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    destroy() {
      stopped = true;
      clearTimeout(retry);
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'local');
      ws?.close();
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwareness);
      awareness.destroy();
      doc.destroy();
    },
  };
}

/** A stable color per participant, so a person is the same color everywhere. */
export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Mid-dark tones that read on the light theme, starting from the palette's Dusk Blue and Burnt Peach.
  const palette = ['#3d5a80', '#c4492b', '#2e7d5b', '#8a5a00', '#6a4c93', '#1f7a8c', '#b0306a', '#4a6fa5'];
  return palette[h % palette.length]!;
}
