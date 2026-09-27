/**
 * The WebSocket to Fabrikka.
 *
 * Carries mention deliveries in, presence out. The server decides what to send —
 * this end never filters (ADR 0010).
 */
import WebSocket from 'ws';

export interface MentionFrame {
  type: 'mention';
  message: {
    id: string;
    author: { participantId: string; displayName: string; kind: string };
    content: string;
    createdAt: string;
  };
  trust: 'owner' | 'session' | 'untrusted';
}

export type ServerFrame =
  | { type: 'ready'; participant: { id: string; display_name: string }; session: { id: string } }
  | MentionFrame
  | { type: 'error'; code: 'unauthenticated' | 'not_found' };

export interface SocketHandlers {
  onReady: (frame: Extract<ServerFrame, { type: 'ready' }>) => void;
  onMention: (frame: MentionFrame) => void;
  /** Called with a permanent refusal. Reconnecting will not help. */
  onRefused: (code: string) => void;
  onDisconnected: () => void;
}

export class BridgeSocket {
  private ws: WebSocket | undefined;
  private retry: NodeJS.Timeout | undefined;
  private closed = false;
  private refused = false;
  private backoffMs = 1000;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: SocketHandlers,
  ) {}

  connect(): void {
    if (this.closed || this.refused) return;

    // Header auth: possible because this is Node, not a browser.
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000;
    });

    ws.on('message', (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(data)) as ServerFrame;
      } catch {
        return;
      }

      if (frame.type === 'ready') this.handlers.onReady(frame);
      else if (frame.type === 'mention') this.handlers.onMention(frame);
      else if (frame.type === 'error') {
        // A refusal is permanent — retrying a bad token just loops.
        this.refused = true;
        this.handlers.onRefused(frame.code);
      }
    });

    ws.on('close', () => {
      this.handlers.onDisconnected();
      if (this.closed || this.refused) return;
      this.retry = setTimeout(() => this.connect(), this.backoffMs);
      // Cap the backoff: a session left open overnight should keep trying, but
      // not hammer a server that is down.
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    ws.on('error', () => {
      // 'close' always follows; reconnection is handled there.
    });
  }

  /** Report presence. Best-effort: losing a status update must not be fatal. */
  send(frame: { type: 'status'; status: 'working' | 'idle' }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(frame));
      } catch {
        // ignore
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }
}
