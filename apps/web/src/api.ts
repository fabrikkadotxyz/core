import type { Message, ServerEvent, SessionView } from '@fabrikka/types';

const SERVER = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:9090';

/** Path segments of the current session, mirroring the MCP endpoint shape. */
export interface SessionRef {
  owner: string;
  session: string;
}

/** `/o/{owner}/s/{session}` — falls back to the M0 seed. */
export function sessionRefFromLocation(): SessionRef {
  const m = window.location.pathname.match(/^\/o\/([^/]+)\/s\/([^/]+)/);
  return m ? { owner: m[1]!, session: m[2]! } : { owner: 'fede', session: 'demo' };
}

function base({ owner, session }: SessionRef): string {
  return `${SERVER}/api/o/${encodeURIComponent(owner)}/s/${encodeURIComponent(session)}`;
}

export async function fetchSession(ref: SessionRef): Promise<SessionView> {
  const res = await fetch(base(ref));
  if (!res.ok) throw new Error(`session not found (${res.status})`);
  return res.json();
}

export async function fetchMessages(ref: SessionRef): Promise<Message[]> {
  const res = await fetch(`${base(ref)}/messages`);
  if (!res.ok) throw new Error(`could not load messages (${res.status})`);
  return res.json();
}

export async function postMessage(
  ref: SessionRef,
  authorParticipantId: string,
  content: string,
): Promise<void> {
  const res = await fetch(
    `${base(ref)}/messages?as=${encodeURIComponent(authorParticipantId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) throw new Error(`could not send (${res.status})`);
}

/** Subscribes to the session event stream. Returns a teardown function. */
export function openStream(
  ref: SessionRef,
  onEvent: (event: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const url = `${base(ref).replace(/^http/, 'ws')}/stream`;
    ws = new WebSocket(url);

    ws.onopen = () => onStatus(true);
    ws.onmessage = (evt) => {
      try {
        onEvent(JSON.parse(evt.data as string) as ServerEvent);
      } catch {
        // Ignore malformed frames rather than tearing down the stream.
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) retry = setTimeout(connect, 1000);
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
