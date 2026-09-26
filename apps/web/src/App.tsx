import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Participant, SessionView } from '@fabrikka/types';
import {
  fetchMessages,
  fetchSession,
  openStream,
  postMessage,
  sessionRefFromLocation,
} from './api.ts';

export default function App() {
  const ref = useMemo(sessionRefFromLocation, []);
  const [view, setView] = useState<SessionView | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  /** No auth until M1, so the tab picks who it is posting as. */
  const [actingAs, setActingAs] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [s, m] = await Promise.all([fetchSession(ref), fetchMessages(ref)]);
        if (cancelled) return;
        setView(s);
        setMessages(m);
        setActingAs(
          (prev) => prev || s.participants.find((p) => p.kind === 'human')?.id || '',
        );
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ref]);

  useEffect(
    () =>
      openStream(
        ref,
        (event) => {
          if (event.type === 'message.created') {
            setMessages((prev) =>
              prev.some((m) => m.id === event.message.id)
                ? prev
                : [...prev, event.message],
            );
          }
          if (event.type === 'hello') setConnected(true);
        },
        setConnected,
      ),
    [ref],
  );

  const send = useCallback(
    async (content: string) => {
      if (!actingAs) return;
      await postMessage(ref, actingAs, content);
    },
    [ref, actingAs],
  );

  if (error) {
    return (
      <main className="empty">
        <h1>Session not found</h1>
        <p>{error}</p>
        <p className="hint">
          Seed the demo session with <code>pnpm db:seed</code>.
        </p>
      </main>
    );
  }

  if (!view) return <main className="empty">Loading…</main>;

  return (
    <div className="app">
      <main className="session">
        <header>
          <h1>
            {view.session.title} <span className="lock" title="Private">🔒</span>
          </h1>
          <span className={connected ? 'status on' : 'status off'}>
            {connected ? 'live' : 'reconnecting…'}
          </span>
        </header>

        <Timeline messages={messages} />

        <Composer
          participants={view.participants}
          actingAs={actingAs}
          onActingAsChange={setActingAs}
          onSend={send}
        />
      </main>

      <aside>
        <Panel title="Participants">
          <ul className="participants">
            {view.participants.map((p) => (
              <li key={p.id}>
                <span className="avatar">{p.kind === 'agent' ? '🤖' : '👤'}</span>
                <span>@{p.displayName}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="MCP endpoint">
          <code className="endpoint">{view.mcpEndpoint}</code>
          <p className="hint">Not served until M3.</p>
        </Panel>
      </aside>
    </div>
  );
}

function Timeline({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="timeline empty-timeline">
        <p>Nothing here yet. Say something.</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      {messages.map((m) => (
        <article key={m.id} className={m.author.kind === 'agent' ? 'msg agent' : 'msg'}>
          <div className="meta">
            <span className="avatar">{m.author.kind === 'agent' ? '🤖' : '👤'}</span>
            <span className="author">@{m.author.displayName}</span>
            <time dateTime={m.createdAt}>
              {new Date(m.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </div>
          <p>{m.content}</p>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}

interface ComposerProps {
  participants: Participant[];
  actingAs: string;
  onActingAsChange: (id: string) => void;
  onSend: (content: string) => Promise<void>;
}

function Composer({
  participants,
  actingAs,
  onActingAsChange,
  onSend,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = value.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      await onSend(content);
      setValue('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      {/* Stands in for auth until M1. */}
      <select
        value={actingAs}
        onChange={(e) => onActingAsChange(e.target.value)}
        aria-label="Post as"
      >
        {participants.map((p) => (
          <option key={p.id} value={p.id}>
            @{p.displayName}
          </option>
        ))}
      </select>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Message everyone…"
        autoComplete="off"
      />
      <button type="submit" disabled={!value.trim() || sending}>
        ➤
      </button>
    </form>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
