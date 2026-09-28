import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  AgentSummary,
  CreatedAgentView,
  InviteSummary,
  ServerEvent,
  SetupLane,
  Message,
  Participant,
  SessionView,
} from '@fabrikka/types';
import {
  ApiError,
  openStream,
  sessions,
  type SessionRef,
  type TokenSummary,
} from '../api.ts';
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
  const [blocked, setBlocked] = useState<
    Extract<ServerEvent, { type: 'mention.blocked' }>[]
  >([]);

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
          if (event.type === 'agents.paused') {
            setView((prev) =>
              prev
                ? {
                    ...prev,
                    agents: { ...prev.agents, paused: event.paused, reason: event.reason },
                  }
                : prev,
            );
          }
          if (event.type === 'presence.updated') {
            setView((prev) =>
              prev
                ? {
                    ...prev,
                    participants: prev.participants.map((p) =>
                      p.id === event.participantId ? { ...p, status: event.status } : p,
                    ),
                  }
                : prev,
            );
          }
          // Surface a mention that did not reach its agent. Silent non-delivery
          // is indistinguishable from a bug (ADR 0010).
          if (event.type === 'mention.blocked') {
            setBlocked((prev) => [...prev.slice(-4), event]);
          }
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
            {/* Any member can pull it: waiting for the owner is the wrong
                failure mode when an agent is misbehaving. */}
            {!view.agents.paused && view.participants.some((p) => p.kind === 'agent') && (
              <button
                className="link danger"
                title="Stop all agent activity in this session"
                onClick={async () => {
                  await sessions.pauseAgents(ref);
                  reload();
                }}
              >
                Pause agents
              </button>
            )}
          </header>

          {view.agents.paused && (
            <div className="paused-banner">
              <div>
                <strong>
                  Agents paused
                  {view.agents.reason === 'turn_budget' && ' — turn budget reached'}
                </strong>
                {/*
                  State the guarantee precisely. A control that implies more than
                  it delivers is worse than none, because it gets trusted at
                  exactly the wrong moment. See ADR 0012.
                */}
                <p>
                  No new work will be sent. Runs already in flight are asked to
                  stop; one that has lost contact may finish on its own, and a
                  live Claude Code session will finish the turn it is on.
                </p>
              </div>
              <button
                onClick={async () => {
                  await sessions.resumeAgents(ref);
                  reload();
                }}
              >
                Resume agents
              </button>
            </div>
          )}

          {blocked.length > 0 && (
            <ul className="blocked-notices">
              {blocked.map((b) => (
                <li key={`${b.messageId}-${b.participantId}`}>
                  @{b.displayName} was not notified —{' '}
                  {b.reason === 'not_trusted'
                    ? 'only its owner can direct it'
                    : b.reason === 'no_connection'
                      ? 'no live connection'
                      : b.reason === 'paused'
                        ? 'agents are paused'
                        : b.reason === 'turn_budget'
                          ? 'the turn budget ran out'
                          : 'it wrote the message'}
                </li>
              ))}
            </ul>
          )}

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
                  {p.kind === 'agent' && (
                    <span className={`presence ${p.status ?? 'offline'}`}>
                      {p.status ?? 'offline'}
                    </span>
                  )}
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

          {isOwner && <AgentsPanel ref_={ref} onChanged={reload} />}

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

/**
 * Connecting an agent.
 *
 * The whole point of M3 is that this is one copy-paste, not a configuration
 * exercise: the server returns a ready-to-run `claude mcp add` command with the
 * token already in it. The token is shown once and is not recoverable, like an
 * invite (ADR 0009).
 */
function AgentsPanel({
  ref_,
  onChanged,
}: {
  ref_: SessionRef;
  onChanged: () => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('claude-code');
  const [fresh, setFresh] = useState<CreatedAgentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    sessions.agents(ref_).then(setAgents).catch(() => {});
    sessions.tokens(ref_).then(setTokens).catch(() => {});
  }, [ref_]);

  useEffect(refresh, [refresh]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) return;
    setError(null);
    try {
      const created = await sessions.addAgent(ref_, { displayName, provider });
      setFresh(created);
      setName('');
      refresh();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Panel title="Agents">
      <form className="stack" onSubmit={add}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="agent name, e.g. claude-fede"
          aria-label="Agent name"
        />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          aria-label="Provider"
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="other">Other MCP agent</option>
        </select>
        <button type="submit" disabled={!name.trim()}>
          Add agent
        </button>
      </form>

      {error && <p className="error small">{error}</p>}

      {fresh && <AgentSetup created={fresh} onError={setError} />}

      {agents.length > 0 && (
        <ul className="participants">
          {agents.map((a) => (
            <li key={a.sessionAgentId}>
              <span>🤖 @{a.displayName}</span>
              <span className="muted small">{a.provider}</span>
              <button
                className="link small"
                title={
                  a.trustTier === 'owner_only'
                    ? 'Only you can direct this agent. Click to let any member direct it.'
                    : 'Any member can direct this agent. Click to restrict it to you.'
                }
                onClick={async () => {
                  await sessions.setAgentTrust(
                    ref_,
                    a.sessionAgentId,
                    a.trustTier === 'owner_only' ? 'session_trusted' : 'owner_only',
                  );
                  refresh();
                }}
              >
                {a.trustTier === 'owner_only' ? 'owner only' : 'session trusted'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {tokens.length > 0 && (
        <>
          <h3 className="subhead">Tokens</h3>
          <ul className="participants">
            {tokens.map((t) => (
              <li key={t.id}>
                <span className="small">@{t.participantName}</span>
                <span className="muted small">
                  {t.lastUsedAt
                    ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                    : 'never used'}
                </span>
                <button
                  className="link small"
                  onClick={async () => {
                    await sessions.revokeToken(ref_, t.id);
                    refresh();
                  }}
                >
                  revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/**
 * How to attach this agent.
 *
 * Only the lanes its provider can actually use are shown, best first — a Codex
 * agent must never be offered a Claude Code channel setup, because that setup
 * cannot work and sends someone off to debug a dead end. The trade-off for each
 * is stated rather than buried. See ARCHITECTURE.md.
 */
const LANE_LABELS: Record<SetupLane, string> = {
  bridge: 'Live session',
  runner: 'While away',
  remote: 'Any MCP client',
};

function AgentSetup({
  created,
  onError,
}: {
  created: CreatedAgentView;
  onError: (msg: string) => void;
}) {
  const { setup, agent } = created;
  const [lane, setLane] = useState<SetupLane>(setup.lanes[0] ?? 'remote');
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      onError('could not copy — select the text and copy it manually');
    }
  };

  const block = (key: string, label: string, value: string) => (
    <>
      <code className="endpoint">{value}</code>
      <button onClick={() => copy(key, value)}>
        {copied === key ? 'Copied ✓' : label}
      </button>
    </>
  );

  return (
    <div className="fresh-invite">
      <p className="hint">
        <strong>Copy this now — the token is shown only once.</strong>
      </p>

      {setup.lanes.length > 1 && (
        <div className="lane-tabs" role="tablist">
          {setup.lanes.map((l) => (
            <button
              key={l}
              role="tab"
              aria-selected={lane === l}
              className={lane === l ? 'active' : undefined}
              onClick={() => setLane(l)}
            >
              {LANE_LABELS[l]}
            </button>
          ))}
        </div>
      )}

      {lane === 'bridge' && setup.bridgeMcpJson && setup.bridgeCommand && (
        <>
          <p className="hint">
            Pushes into a Claude Code session you already have open, with your repo
            loaded. Save this as <code>.mcp.json</code> in that project:
          </p>
          {block('json', 'Copy .mcp.json', setup.bridgeMcpJson)}
          <p className="hint">Then start Claude Code with the channel opted in:</p>
          {block('cmd', 'Copy command', setup.bridgeCommand)}
          <p className="hint">
            The <code>--dangerously-</code> flag is required because channels are a
            research preview and third-party ones are not on Anthropic's allowlist.
          </p>
        </>
      )}

      {lane === 'runner' && setup.runnerCommand && (
        <>
          <p className="hint">
            Spawns a fresh headless agent for each mention, in whichever directory
            you run this from. Use it when you're away from the terminal.
          </p>
          {block('runner', 'Copy command', setup.runnerCommand)}
          <p className="hint danger-hint">
            {agent.provider === 'codex' ? (
              <>
                <strong>Runs start without approval prompts</strong>, inside a
                workspace-write sandbox. Only mentions from you can trigger them.
              </>
            ) : (
              <>
                <strong>Runs start without permission prompts, and without a
                sandbox.</strong>{' '}
                Only mentions from you can trigger them.
              </>
            )}{' '}
            The command prints what it will do before it does anything — read it.
          </p>
        </>
      )}

      {lane === 'remote' && (
        <>
          <p className="hint">
            {agent.provider === 'codex'
              ? 'Registers the session with the Codex CLI. '
              : agent.provider === 'claude-code'
                ? 'Registers the session with Claude Code. '
                : 'Point any MCP client at this endpoint. '}
            The agent can read and post, but <strong>cannot be woken</strong>: it
            participates only while it happens to be running.
          </p>
          {block('remote', 'Copy command', setup.remoteCommand)}
        </>
      )}

      {agent.provider !== 'claude-code' && setup.lanes.includes('runner') && (
        <p className="hint">
          Live-session push is Claude Code only — <code>claude/channel</code> is
          proprietary and stdio-only, so it has no equivalent here.
        </p>
      )}
    </div>
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
