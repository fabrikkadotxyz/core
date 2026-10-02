import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  ActivityEvent,
  AgentSummary,
  Artifact,
  CreatedAgentView,
  InviteSummary,
  Run,
  ServerEvent,
  SessionContext,
  SetupLane,
  Message,
  Output,
  OutputEditSummary,
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
import { OutputsPanel, timeAgo, type OutputTab } from '../outputs/Outputs.tsx';

/** The editor is most of the bundle; load it when a document is first opened. */
const OutputView = lazy(() => import('../outputs/OutputView.tsx'));

interface PaneState {
  setup: boolean;
  output: boolean;
  /** Width of the output rail, in px. See `clampWidth`. */
  outputWidth: number;
  /**
   * Width while a document is open. Separate, so closing the document gives
   * back exactly the width you had chosen for the list (ADR 0019).
   */
  docWidth: number;
  /** The document open in the output rail, if any. */
  openOutput: string | null;
}

/** Setup is a one-time job; the conversation is the hour-long one. */
const PANES_DEFAULT: PaneState = {
  setup: false,
  output: true,
  outputWidth: 320,
  docWidth: 0, // 0 = "as wide as allowed", resolved by clampWidth
  openOutput: null,
};

/**
 * Bounds for the output rail.
 *
 * A lower bound because the panels below it stop being readable, an upper bound
 * because the conversation must not become the narrow half again — which is the
 * whole reason this milestone exists. The viewport term matters on a laptop, where
 * 640px of rail plus a setup rail leaves very little in between.
 */
const RAIL_MIN = 260;
const RAIL_MAX = 640;

/**
 * A document being written needs more room than a list of panels, so with one
 * open the 640px cap lifts and only the 60%-of-window rule remains: the
 * conversation still never becomes the narrow half.
 */
const DOC_MIN = 380;

function railBounds(doc: boolean): { min: number; max: number } {
  const sixty = Math.round(window.innerWidth * 0.6);
  return doc
    ? { min: Math.min(DOC_MIN, sixty), max: Math.max(Math.min(DOC_MIN, sixty), sixty) }
    : { min: RAIL_MIN, max: Math.max(RAIL_MIN, Math.min(RAIL_MAX, sixty)) };
}

function clampWidth(px: number, doc = false): number {
  const { min, max } = railBounds(doc);
  if (doc && px <= 0) return max;
  return Math.max(min, Math.min(Math.round(px), max));
}

/**
 * Which side panes are open, remembered per session.
 *
 * Per viewer and per device, so it lives in `localStorage` rather than on the
 * server: collapsing the rail on a laptop says nothing about a phone, and it is
 * not worth an endpoint and a write for something re-decided in one click
 * (ADR 0018). Every access is guarded — storage can be disabled or cleared, and
 * a preference that throws must not take the session screen down with it.
 */
function usePanes(
  key: string,
): [PaneState, (next: PaneState | ((prev: PaneState) => PaneState)) => void] {
  const storageKey = `fabrikka.panes.${key}`;

  const [panes, setPanes] = useState<PaneState>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return PANES_DEFAULT;
      const parsed = JSON.parse(raw) as Partial<PaneState>;
      return {
        setup: typeof parsed.setup === 'boolean' ? parsed.setup : PANES_DEFAULT.setup,
        output: typeof parsed.output === 'boolean' ? parsed.output : PANES_DEFAULT.output,
        // Re-clamped on read: a width stored on a wide monitor is not a width
        // that works on the laptop this tab is open on.
        outputWidth:
          typeof parsed.outputWidth === 'number' && Number.isFinite(parsed.outputWidth)
            ? clampWidth(parsed.outputWidth)
            : PANES_DEFAULT.outputWidth,
        docWidth:
          typeof parsed.docWidth === 'number' && Number.isFinite(parsed.docWidth)
            ? parsed.docWidth
            : PANES_DEFAULT.docWidth,
        openOutput: typeof parsed.openOutput === 'string' ? parsed.openOutput : null,
      };
    } catch {
      return PANES_DEFAULT;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(panes));
    } catch {
      // A session that works but forgets a pane preference is fine.
    }
  }, [storageKey, panes]);

  return [panes, setPanes];
}

/**
 * The drag handle on the output rail's inner edge.
 *
 * Pointer events rather than mouse events, so a trackpad, a touch screen and a
 * pen all work from one code path, and pointer capture keeps the drag alive when
 * the cursor outruns the handle.
 *
 * It is also a real `separator` with arrow-key support. A resizer only a mouse
 * can reach is a control that half the people using this do not have — and the
 * keyboard path is what makes the bounds discoverable at all.
 */
function RailHandle({
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (px: number) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  // The rail is on the right, so its width is the distance from the pointer to
  // the workspace's right edge — measured, not assumed to be the window's.
  const widthFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const right =
      e.currentTarget.parentElement?.getBoundingClientRect().right ?? window.innerWidth;
    return right - e.clientX;
  };

  return (
    <div
      className={dragging ? 'rail-handle dragging' : 'rail-handle'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the output pane"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onResize(widthFromPointer(e));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') onResize(width + step);
        else if (e.key === 'ArrowRight') onResize(width - step);
        else if (e.key === 'Home') onResize(max);
        else if (e.key === 'End') onResize(min);
        else return;
        // Arrow keys scroll the pane behind the handle otherwise.
        e.preventDefault();
      }}
    />
  );
}

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
  /** Bumped when context or artifacts change elsewhere, to refetch the panels. */
  const [panelsVersion, setPanelsVersion] = useState(0);
  /**
   * What agents are doing right now. Both are capped: activity is a live feed,
   * not a log — the durable record is the messages agents post (ADR 0015).
   */
  const [runs, setRuns] = useState<Run[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [panes, setPanes] = usePanes(`${owner}/${session}`);
  /** Live documents, refetched when the stream says one changed. */
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [outputsVersion, setOutputsVersion] = useState(0);
  /** Agent edits, for the timeline. Human typing lives in each document's History. */
  const [agentEdits, setAgentEdits] = useState<OutputEditSummary[]>([]);
  const [outputTab, setOutputTab] = useState<OutputTab>('edit');
  const [focusEdit, setFocusEdit] = useState<OutputEditSummary | null>(null);
  const [renameOnOpen, setRenameOnOpen] = useState(false);
  /** An agent changed the document you are looking at: say so, once. */
  const [editToast, setEditToast] = useState<OutputEditSummary | null>(null);
  const openOutputRef = useRef<string | null>(panes.openOutput);
  openOutputRef.current = panes.openOutput;

  const togglePane = (which: 'setup' | 'output') =>
    setPanes((prev) => ({ ...prev, [which]: !prev[which] }));

  const docOpen = panes.openOutput !== null;
  const resizeOutput = (px: number) =>
    setPanes((prev) =>
      prev.openOutput
        ? { ...prev, docWidth: clampWidth(px, true) }
        : { ...prev, outputWidth: clampWidth(px) },
    );
  const resetOutputWidth = () =>
    setPanes((prev) =>
      prev.openOutput ? { ...prev, docWidth: 0 } : { ...prev, outputWidth: PANES_DEFAULT.outputWidth },
    );
  const railWidth = docOpen ? clampWidth(panes.docWidth, true) : panes.outputWidth;
  const bounds = railBounds(docOpen);

  const openOutput = (id: string, opts: { tab?: OutputTab; edit?: OutputEditSummary; rename?: boolean } = {}) => {
    setOutputTab(opts.tab ?? 'edit');
    setFocusEdit(opts.edit ?? null);
    setRenameOnOpen(!!opts.rename);
    setEditToast(null);
    setPanes((prev) => ({ ...prev, output: true, openOutput: id }));
  };
  /** "Show me" on a paper means the page it changed; on a document, the diff. */
  const showTab = (e: OutputEditSummary): OutputTab =>
    outputs.find((o) => o.id === e.outputId)?.kind === 'latex' ? 'preview' : 'history';
  const closeOutput = () => {
    setEditToast(null);
    setPanes((prev) => ({ ...prev, openOutput: null }));
  };

  useEffect(() => {
    sessions
      .outputs(ref)
      .then((list) => {
        setOutputs(list);
        // A remembered document that has since been deleted just closes.
        if (openOutputRef.current && !list.some((o) => o.id === openOutputRef.current)) {
          setPanes((prev) => ({ ...prev, openOutput: null }));
        }
      })
      .catch(() => {});
  }, [ref, outputsVersion, setPanes]);

  useEffect(() => {
    sessions.recentAgentEdits(ref).then(setAgentEdits).catch(() => {});
  }, [ref]);

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
          // Catch-up: a tab opened mid-run still sees the run and what led to it.
          if (event.type === 'hello') {
            setRuns(event.runs ?? []);
            setActivity(event.activity ?? []);
          }
          if (event.type === 'activity') {
            setActivity((prev) => [...prev, event.event].slice(-300));
          }
          if (event.type === 'run.started') {
            setRuns((prev) =>
              prev.some((r) => r.id === event.run.id) ? prev : [...prev, event.run],
            );
          }
          if (event.type === 'run.ended') {
            // The run stays in the list, now ended: its activity is still on
            // screen and would otherwise lose the name it belongs to.
            setRuns((prev) =>
              prev.map((r) => (r.id === event.run.id ? event.run : r)),
            );
          }
          // Patch the participant list rather than refetching messages: chips
          // resolve names from this list, so a rename updates every message on
          // screen at once. That is the point of storing ids, not names.
          if (event.type === 'context.updated' || event.type === 'artifact.created') {
            // Panels own their own state; a bump is enough to make them refetch.
            setPanelsVersion((v) => v + 1);
          }
          if (event.type === 'output.changed') setOutputsVersion((v) => v + 1);
          if (event.type === 'output.edited') {
            const e = event.edit;
            setOutputsVersion((v) => v + 1);
            if (e.participantKind === 'agent') {
              setAgentEdits((prev) =>
                prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 200),
              );
              if (e.outputId === openOutputRef.current) setEditToast(e);
            }
          }
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

      <div
        className="workspace"
        data-setup={panes.setup ? 'open' : 'closed'}
        data-output={panes.output ? 'open' : 'closed'}
        data-doc={docOpen ? 'open' : 'closed'}
        style={{ '--rail-output-w': `${railWidth}px` } as React.CSSProperties}
      >
        {/*
          Left — SETUP: everything that CHANGES the session. Collapsible, because
          you add an agent once and then talk for an hour (ADR 0018).
        */}
        <aside className="rail setup" aria-label="Session setup" aria-hidden={!panes.setup}>
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

          {/*
            ANY member may add their own agent — the server has allowed it since
            M3, and @claude-alice is half the multi-participant story (ADR 0004).
            This panel was gated on isOwner until M11, which made it impossible
            through the UI.
          */}
          <AgentsPanel
            ref_={ref}
            onChanged={reload}
            isOwner={isOwner}
            myUserId={user?.id}
          />

          <IntegrationsPanel ref_={ref} isOwner={isOwner} />

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

        {/* Middle — the session happening. Never collapses; it is the product. */}
        <main className="session">
          <header>
            <button
              className={panes.setup ? 'pane-toggle on' : 'pane-toggle'}
              aria-expanded={panes.setup}
              title="Agents, members, integrations, invites"
              onClick={() => togglePane('setup')}
            >
              Setup
            </button>

            <h1>
              {view.session.title} <span title="Private">🔒</span>
              {view.session.status === 'archived' && <em className="badge">archived</em>}
            </h1>
            <span className={connected ? 'status on' : 'status off'}>
              {connected ? 'live' : 'reconnecting…'}
            </span>
            <span className="spacer" />
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

            <button
              className={panes.output ? 'pane-toggle on' : 'pane-toggle'}
              aria-expanded={panes.output}
              title="What this session has produced: documents, context and files"
              onClick={() => togglePane('output')}
            >
              Output
            </button>
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
            activity={activity}
            edits={agentEdits}
            runs={runs}
            participants={view.participants}
            meParticipantId={view.me.participantId}
            onShowEdit={(e) => openOutput(e.outputId, { tab: showTab(e), edit: e })}
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

        {/*
          Right — OUTPUT: what the session PRODUCED. Context and artifacts are
          written by agents through MCP, so this pane is already filled by AI;
          it is filled by tool calls rather than by a button (ADR 0018).
        */}
        {/* A sibling of the rail, not a child: the rail scrolls, and a handle
            that scrolls away is a handle you cannot reach. */}
        {panes.output && (
          <RailHandle
            width={railWidth}
            min={bounds.min}
            max={bounds.max}
            onResize={resizeOutput}
            onReset={resetOutputWidth}
          />
        )}

        <aside className="rail output" aria-label="Session output" aria-hidden={!panes.output}>
          {(() => {
            const open = outputs.find((o) => o.id === panes.openOutput);
            const me = view.participants.find((p) => p.id === view.me.participantId);
            if (open && me) {
              return (
                <>
                  {editToast && (
                    <div className="edit-toast" role="status">
                      <span>
                        ✎ @{editToast.displayName} just edited this (+{editToast.added} −
                        {editToast.removed})
                      </span>
                      <button
                        className="link"
                        onClick={() => {
                          setOutputTab(showTab(editToast));
                          setFocusEdit(editToast);
                          setEditToast(null);
                        }}
                      >
                        Show me
                      </button>
                      <button className="link muted" aria-label="Dismiss" onClick={() => setEditToast(null)}>
                        ✕
                      </button>
                    </div>
                  )}
                  <Suspense fallback={<p className="muted small">Opening…</p>}>
                  <OutputView
                    key={open.id}
                    ref_={ref}
                    output={open}
                    me={me}
                    canDelete={isOwner || open.createdBy.participantId === view.me.participantId}
                    tab={outputTab}
                    onTab={(t) => {
                      setOutputTab(t);
                      if (t !== 'history') setFocusEdit(null);
                    }}
                    focusEdit={focusEdit}
                    renameOnOpen={renameOnOpen}
                    editsVersion={outputsVersion}
                    onClose={closeOutput}
                  />
                  </Suspense>
                </>
              );
            }
            return (
              <>
                <OutputsPanel ref_={ref} outputs={outputs} onOpen={(id, o) => openOutput(id, o)} />
                <ContextPanel key={`ctx-${panelsVersion}`} ref_={ref} />
                <ArtifactsPanel key={`art-${panelsVersion}`} ref_={ref} />
              </>
            );
          })()}
        </aside>

        {/*
          On a narrow screen the rails are overlays, so a backdrop is the way out.
          Hidden by CSS at desktop widths, where nothing overlaps anything.
        */}
        {(panes.setup || panes.output) && (
          <button
            className="pane-backdrop"
            aria-label="Close panel"
            onClick={() => setPanes((prev) => ({ ...prev, setup: false, output: false }))}
          />
        )}
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
  isOwner,
  myUserId,
}: {
  ref_: SessionRef;
  onChanged: () => void;
  isOwner: boolean;
  myUserId: string | undefined;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('claude-code');
  const [fresh, setFresh] = useState<CreatedAgentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    sessions.agents(ref_).then(setAgents).catch(() => {});
    // Owner-only on the server (404 otherwise). Asking anyway would work, but a
    // request whose failure we plan on is a request not worth sending.
    if (isOwner) sessions.tokens(ref_).then(setTokens).catch(() => {});
  }, [ref_, isOwner]);

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
              {/*
                Trust and step visibility are the AGENT owner's call, and the
                server answers 404 to anyone else. Showing the buttons to a
                member who cannot use them would be a control that fails on
                click — the rule is absent, not broken (ADR 0018).
              */}
              {a.ownerUserId !== myUserId ? (
                <span className="muted small">
                  {a.trustTier === 'owner_only' ? 'owner only' : 'session trusted'}
                </span>
              ) : (
                <>
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
                  <button
                    className="link small"
                    title={
                      a.activityVisible
                        ? 'This agent\u2019s steps stream to the session. Click to hide them.'
                        : 'This agent works silently. Click to stream its steps.'
                    }
                    onClick={async () => {
                      await sessions.setAgentActivity(
                        ref_,
                        a.sessionAgentId,
                        !a.activityVisible,
                      );
                      refresh();
                    }}
                  >
                    {a.activityVisible ? 'steps shown' : 'steps hidden'}
                  </button>
                </>
              )}
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

/**
 * Session context.
 *
 * Adds are appends, so typing here cannot delete what an agent recorded while you
 * were typing — and vice versa. See ADR 0013.
 */
function ContextPanel({ ref_ }: { ref_: SessionRef }) {
  const [context, setContext] = useState<SessionContext | null>(null);
  const [objective, setObjective] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    sessions
      .context(ref_)
      .then((c) => {
        setContext(c);
        setObjective(c.objective ?? '');
      })
      .catch(() => {});
  }, [ref_]);

  useEffect(load, [load]);

  const lists = [
    ['facts', 'Facts'],
    ['decisions', 'Decisions'],
    ['questions', 'Open questions'],
    ['constraints', 'Constraints'],
  ] as const;

  const apply = async (update: Parameters<typeof sessions.updateContext>[1]) => {
    setError(null);
    try {
      setContext(await sessions.updateContext(ref_, update));
    } catch (err) {
      // A 409 means someone else wrote first. Reload rather than insist.
      setError((err as Error).message);
      load();
    }
  };

  if (!context) return null;

  return (
    <Panel title="Context">
      <label className="ctx-objective">
        Objective
        <textarea
          value={objective}
          rows={2}
          placeholder="What is this session for?"
          onChange={(e) => setObjective(e.target.value)}
          onBlur={() => {
            if (objective !== (context.objective ?? '')) void apply({ objective });
          }}
        />
      </label>

      {lists.map(([key, label]) => (
        <div key={key} className="ctx-list">
          <h3 className="subhead">{label}</h3>
          {context[key].length > 0 && (
            <ul>
              {context[key].map((item) => (
                <li key={item}>
                  <span>{item}</span>
                  <button
                    className="link small"
                    title="Remove"
                    onClick={() => void apply({ remove: { [key]: [item] } })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            value={drafts[key] ?? ''}
            placeholder={`Add a ${label.toLowerCase().replace(/s$/, '')}…`}
            onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const value = (drafts[key] ?? '').trim();
              if (!value) return;
              setDrafts((d) => ({ ...d, [key]: '' }));
              void apply({ add: { [key]: [value] } });
            }}
          />
        </div>
      ))}

      {error && <p className="error small">{error}</p>}
    </Panel>
  );
}

function ArtifactsPanel({ ref_ }: { ref_: SessionRef }) {
  const [list, setList] = useState<Artifact[]>([]);
  const [linkUrl, setLinkUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    sessions.artifacts(ref_).then(setList).catch(() => {});
  }, [ref_]);

  useEffect(load, [load]);

  return (
    <Panel title="Artifacts">
      <div className="stack">
        <input
          ref={fileRef}
          type="file"
          aria-label="Upload a file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setError(null);
            try {
              await sessions.uploadFile(ref_, file);
              load();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              if (fileRef.current) fileRef.current.value = '';
            }
          }}
        />
        <input
          value={linkUrl}
          placeholder="…or paste a link and press Enter"
          onChange={(e) => setLinkUrl(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !linkUrl.trim()) return;
            setError(null);
            try {
              await sessions.addLink(ref_, linkUrl.trim(), linkUrl.trim());
              setLinkUrl('');
              load();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      </div>

      {error && <p className="error small">{error}</p>}

      {list.length > 0 && (
        <ul className="participants">
          {list.map((a) => (
            <li key={a.id}>
              <span>{a.type === 'link' ? '🔗' : '📄'}</span>
              <a
                href={a.url ?? sessions.artifactUrl(ref_, a.id)}
                target="_blank"
                rel="noreferrer"
              >
                {a.name}
              </a>
              <span className="muted small">@{a.createdBy.displayName}</span>
              <button
                className="link small"
                onClick={async () => {
                  await sessions.deleteArtifact(ref_, a.id);
                  load();
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * External MCP servers.
 *
 * Two lists on purpose: the integrations YOU have attached (with your own
 * credential), and which integrations exist in the session so grants are
 * comprehensible. You never see whose credential is behind someone else's —
 * ADR 0004.
 */
function IntegrationsPanel({ ref_, isOwner }: { ref_: SessionRef; isOwner: boolean }) {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof sessions.integrations>
  > | null>(null);
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [tools, setTools] = useState<Record<string, { name: string }[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    sessions.integrations(ref_).then(setState).catch(() => {});
  }, [ref_]);

  useEffect(load, [load]);

  if (!state) return null;

  const attach = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await sessions.attachIntegration(ref_, {
        slug: slug.trim(),
        url: url.trim(),
        credential: credential.trim() || undefined,
      });
      setSlug('');
      setUrl('');
      setCredential('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const granted = (s: string, t: string) =>
    state.grants.some((g) => g.serverSlug === s && g.toolName === t && g.allowed);

  return (
    <Panel title="Integrations">
      {!state.encryptionConfigured && (
        <p className="hint danger-hint">
          <code>FABRIKKA_ENCRYPTION_KEY</code> is not set, so credentials cannot be
          stored. Attaching one will be refused rather than saved in plaintext.
        </p>
      )}

      <form className="stack" onSubmit={attach}>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="slug, e.g. github"
          aria-label="Integration slug"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/mcp"
          aria-label="Server URL"
        />
        <input
          type="password"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          placeholder="bearer token (yours)"
          aria-label="Credential"
          autoComplete="off"
        />
        <button type="submit" disabled={!slug.trim() || !url.trim()}>
          Attach
        </button>
      </form>

      {error && <p className="error small">{error}</p>}

      {state.mine.length > 0 && (
        <>
          <h3 className="subhead">Yours</h3>
          <ul className="participants">
            {state.mine.map((m) => (
              <li key={m.slug}>
                <span>{m.label}</span>
                <span className="muted small">
                  {m.hasCredential ? 'credential set' : 'no credential'}
                </span>
                <button
                  className="link small"
                  onClick={async () => {
                    const list = await sessions.integrationTools(ref_, m.slug);
                    setTools((t) => ({ ...t, [m.slug]: list }));
                  }}
                >
                  tools
                </button>
                <button
                  className="link small"
                  onClick={async () => {
                    await sessions.detachIntegration(ref_, m.slug);
                    load();
                  }}
                >
                  detach
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {Object.entries(tools).map(([s, list]) => (
        <div key={s}>
          <h3 className="subhead">{s} — what this session allows</h3>
          <p className="hint">
            Nothing is permitted until you allow it, and a grant applies to everyone
            in the session — each person still uses their own credential.
          </p>
          <ul className="participants">
            {list.map((t) => (
              <li key={t.name}>
                <label className="grant">
                  <input
                    type="checkbox"
                    checked={granted(s, t.name)}
                    disabled={!isOwner}
                    onChange={async (e) => {
                      await sessions.setToolGrant(ref_, s, t.name, e.target.checked);
                      load();
                    }}
                  />
                  <span className="small">{t.name}</span>
                </label>
              </li>
            ))}
          </ul>
          {!isOwner && <p className="hint">Only the session owner can change grants.</p>}
        </div>
      ))}

      {state.inSession.length > 0 && (
        <>
          <h3 className="subhead">In this session</h3>
          <ul className="participants">
            {state.inSession.map((i) => (
              <li key={i.slug}>
                <span className="small">{i.label}</span>
                <span className="muted small">
                  attached by {i.attachedBy} member{i.attachedBy === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/**
 * The timeline, with agent steps interleaved chronologically.
 *
 * Activity renders inline rather than in a side panel: the point is that you watch
 * the work happen in the same place you read the conversation.
 */
function Timeline({
  messages,
  activity,
  edits,
  runs,
  participants,
  meParticipantId,
  onShowEdit,
}: {
  messages: Message[];
  activity: ActivityEvent[];
  /** Agent edits to documents: display only, never messages (ADR 0019). */
  edits: OutputEditSummary[];
  runs: Run[];
  participants: Participant[];
  meParticipantId: string;
  onShowEdit: (e: OutputEditSummary) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activity.length, edits.length]);

  const items = useMemo(
    () =>
      [
        ...messages.map((m) => ({ at: m.createdAt, kind: 'message' as const, message: m })),
        ...activity.map((a) => ({ at: a.at, kind: 'activity' as const, event: a })),
        ...edits.map((e) => ({ at: e.at, kind: 'edit' as const, edit: e })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [messages, activity, edits],
  );

  const running = runs.filter((r) => r.status === 'running');

  if (items.length === 0 && running.length === 0) {
    return (
      <div className="timeline empty-timeline">
        <p>Nothing here yet. Say something.</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      {items.map((item, i) =>
        item.kind === 'edit' ? (
          <button
            key={`e-${item.edit.id}`}
            className="activity edit-line"
            title="Open the document and see exactly what changed"
            onClick={() => onShowEdit(item.edit)}
          >
            <span className="activity-agent">@{item.edit.displayName}</span>
            <span>
              edited <strong>{item.edit.outputName}</strong>
            </span>
            <span className="history-delta">
              <span className="plus">+{item.edit.added}</span>{' '}
              <span className="minus">−{item.edit.removed}</span>
            </span>
            <span className="muted small">{timeAgo(item.edit.at)} · see change →</span>
          </button>
        ) : item.kind === 'activity' ? (
          <div key={`a-${i}`} className="activity">
            <span className="activity-agent">@{item.event.displayName}</span>
            <span className="activity-tool">{item.event.tool}</span>
            {item.event.detail && (
              <span className="activity-detail">{item.event.detail}</span>
            )}
          </div>
        ) : (
          <article
            key={item.message.id}
            className={item.message.author.kind === 'agent' ? 'msg agent' : 'msg'}
          >
            <div className="meta">
              <span>{item.message.author.kind === 'agent' ? '🤖' : '👤'}</span>
              <span className="author">@{item.message.author.displayName}</span>
              <time dateTime={item.message.createdAt}>
                {new Date(item.message.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
            <p>
              <MentionText
                content={item.message.content}
                participants={participants}
                fallback={item.message.mentions}
                meParticipantId={meParticipantId}
              />
            </p>
          </article>
        ),
      )}

      {/* A run with no steps yet still shows as alive, so "working" is never a
          silent gap. */}
      {running.map((r) => (
        <div key={r.id} className="activity running">
          <span className="activity-agent">@{r.displayName}</span>
          <span className="activity-tool">working…</span>
        </div>
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
