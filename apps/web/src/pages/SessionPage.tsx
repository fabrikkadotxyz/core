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
import { MentionComposer, MentionText } from '../mentions.tsx';

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
          // Patch the participant list rather than refetching messages: chips
          // resolve names from this list, so a rename updates every message on
          // screen at once. That is the point of storing ids, not names.
          if (event.type === 'participant.updated') {
            setView((prev) =>
              prev
                ? {
                    ...prev,
                    participants: prev.participants.map((p) =>
                      p.id === event.participant.id ? event.participant : p,
                    ),
                  }
                : prev,
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

  const send = async (content: string, mentions: string[]) => {
    await sessions.postMessage(ref, content, mentions);
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

          <Timeline
            messages={messages}
            participants={view.participants}
            meParticipantId={view.me.participantId}
          />
          <MentionComposer
            participants={view.participants}
            onSend={send}
            disabled={view.session.status === 'archived'}
            placeholder={
              view.session.status === 'archived'
                ? 'This session is archived'
                : 'Message everyone…  @ to mention'
            }
          />
        </main>

        <aside>
          <Panel title="Participants">
            <ul className="participants">
              {view.participants.map((p: Participant) => (
                <li key={p.id}>
                  <span>{p.kind === 'agent' ? '🤖' : '👤'}</span>
                  <span>@{p.displayName}</span>
                  {p.id === view.me.participantId && <em className="small">you</em>}
                  {(p.id === view.me.participantId || isOwner) && (
                    <button
                      className="link small"
                      onClick={async () => {
                        const next = window.prompt(
                          `Rename @${p.displayName} in this session`,
                          p.displayName,
                        );
                        if (!next?.trim() || next.trim() === p.displayName) return;
                        try {
                          await sessions.renameParticipant(ref, p.id, next.trim());
                          reload();
                        } catch (err) {
                          window.alert((err as Error).message);
                        }
                      }}
                    >
                      rename
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="hint">
              Renaming updates every message that mentioned them, including old
              ones.
            </p>
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

function Timeline({
  messages,
  participants,
  meParticipantId,
}: {
  messages: Message[];
  participants: Participant[];
  meParticipantId: string;
}) {
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
          <p>
            <MentionText
              content={m.content}
              participants={participants}
              fallback={m.mentions}
              meParticipantId={meParticipantId}
            />
          </p>
        </article>
      ))}
      <div ref={endRef} />
    </div>
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
