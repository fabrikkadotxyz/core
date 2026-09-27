import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  InviteSummary,
  Message,
  Participant,
  SessionView,
} from '@fabrikka/types';
import { ApiError, openStream, sessions, type SessionRef } from '../api.ts';
import { useAuth } from '../auth-context.tsx';

export function SessionPage() {
  const { owner = '', session = '' } = useParams();
  const ref = useMemo<SessionRef>(() => ({ owner, session }), [owner, session]);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [view, setView] = useState<SessionView | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [connected, setConnected] = useState(false);

  const reload = useCallback(() => {
    sessions
      .get(ref)
      .then(setView)
      .catch((err) => {
        // 404 covers "doesn't exist" and "not yours" alike, by design.
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
      });
  }, [ref]);

  useEffect(() => {
    reload();
    sessions.messages(ref).then(setMessages).catch(() => {});
  }, [ref, reload]);

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
        },
        setConnected,
      ),
    [ref],
  );

  if (notFound) {
    return (
      <main className="centered">
        <div className="card">
          <h1>Session not found</h1>
          <p className="muted">
            It doesn't exist, or you're not a member of it.
          </p>
          <Link to="/">Back to sessions</Link>
        </div>
      </main>
    );
  }

  if (!view) return <main className="centered">Loading…</main>;

  const isOwner = view.me.role === 'owner';

  const send = async (content: string) => {
    await sessions.postMessage(ref, content);
  };

  const rename = async () => {
    const next = window.prompt('Rename session', view.session.title);
    if (!next?.trim()) return;
    await sessions.update(ref, { title: next.trim() });
    reload();
  };

  const toggleArchive = async () => {
    const status = view.session.status === 'archived' ? 'active' : 'archived';
    await sessions.update(ref, { status });
    reload();
  };

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="link">
          ← Sessions
        </Link>
        <span className="spacer" />
        <span className="muted">@{user?.ownerSlug}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>

      <div className="app">
        <main className="session">
          <header>
            <h1>
              {view.session.title} <span title="Private">🔒</span>
              {view.session.status === 'archived' && <em className="badge">archived</em>}
            </h1>
            <span className={connected ? 'status on' : 'status off'}>
              {connected ? 'live' : 'reconnecting…'}
            </span>
          </header>

          <Timeline messages={messages} />
          <Composer onSend={send} disabled={view.session.status === 'archived'} />
        </main>

        <aside>
          <Panel title="Participants">
            <ul className="participants">
              {view.participants.map((p: Participant) => (
                <li key={p.id}>
                  <span>{p.kind === 'agent' ? '🤖' : '👤'}</span>
                  <span>@{p.displayName}</span>
                  {p.id === view.me.participantId && <em className="small">you</em>}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={`Members (${view.members.length})`}>
            <ul className="participants">
              {view.members.map((m) => (
                <li key={m.userId}>
                  <span>{m.displayName}</span>
                  <span className="muted small">{m.role}</span>
                  {isOwner && m.userId !== user?.id && (
                    <button
                      className="link small"
                      onClick={async () => {
                        await sessions.removeMember(ref, m.userId);
                        reload();
                      }}
                    >
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          {isOwner && <InvitesPanel ref_={ref} />}

          <Panel title="MCP endpoint">
            <code className="endpoint">{view.mcpEndpoint}</code>
            <p className="hint">Not served until M3.</p>
          </Panel>

          {isOwner && (
            <Panel title="Settings">
              <div className="stack">
                <button className="link" onClick={rename}>
                  Rename session
                </button>
                <button className="link" onClick={toggleArchive}>
                  {view.session.status === 'archived' ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  className="link danger"
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Delete “${view.session.title}”? This cannot be undone.`,
                      )
                    ) {
                      return;
                    }
                    await sessions.remove(ref);
                    navigate('/', { replace: true });
                  }}
                >
                  Delete session
                </button>
              </div>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Invites.
 *
 * The plaintext token exists only in the response that created it, so the UI
 * shows it once and offers a copy button. Delivery is out of band, by design.
 */
function InvitesPanel({ ref_ }: { ref_: SessionRef }) {
  const [list, setList] = useState<InviteSummary[]>([]);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [scopeEmail, setScopeEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    sessions.invites(ref_).then(setList).catch(() => {});
  }, [ref_]);

  useEffect(refresh, [refresh]);

  const create = async () => {
    setError(null);
    try {
      const created = await sessions.createInvite(
        ref_,
        scopeEmail.trim() ? { invitedEmail: scopeEmail.trim() } : {},
      );
      setFreshUrl(created.url);
      setScopeEmail('');
      setCopied(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async () => {
    if (!freshUrl) return;
    try {
      await navigator.clipboard.writeText(freshUrl);
      setCopied(true);
    } catch {
      setError('could not copy — select the link and copy it manually');
    }
  };

  const pending = list.filter((i) => !i.redeemedAt && !i.revokedAt);

  return (
    <Panel title="Invites">
      <div className="stack">
        <input
          value={scopeEmail}
          onChange={(e) => setScopeEmail(e.target.value)}
          placeholder="restrict to an email (optional)"
          aria-label="Restrict invite to an email address"
        />
        <button onClick={create}>Create invite link</button>
      </div>

      {error && <p className="error small">{error}</p>}

      {freshUrl && (
        <div className="fresh-invite">
          <p className="hint">
            <strong>Copy this now — it is shown only once.</strong> Anyone with
            this link can join until it's redeemed, revoked, or expires.
          </p>
          <code className="endpoint">{freshUrl}</code>
          <button onClick={copy}>{copied ? 'Copied ✓' : 'Copy invite link'}</button>
        </div>
      )}

      {pending.length > 0 && (
        <ul className="participants">
          {pending.map((i) => (
            <li key={i.id}>
              <span className="small">
                {i.invitedEmail ?? 'anyone with the link'}
              </span>
              <span className="muted small">
                expires {new Date(i.expiresAt).toLocaleDateString()}
              </span>
              <button
                className="link small"
                onClick={async () => {
                  await sessions.revokeInvite(ref_, i.id);
                  refresh();
                }}
              >
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
            <span>{m.author.kind === 'agent' ? '🤖' : '👤'}</span>
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

function Composer({
  onSend,
  disabled,
}: {
  onSend: (content: string) => Promise<void>;
  disabled?: boolean;
}) {
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
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={disabled ? 'This session is archived' : 'Message everyone…'}
        autoComplete="off"
        disabled={disabled}
      />
      <button type="submit" disabled={!value.trim() || sending || disabled}>
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
