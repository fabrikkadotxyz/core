import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select, TeamInitial } from '../components/Select.tsx';
import { inDesktopApp, openFolders } from '../desktop.ts';
import { AGENT_TOOLS, agentTool } from '@fabrikka/types';
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
  LinkType,
  SessionLink,
  TeamMember,
  TeamSummary,
  CatchUp,
  DeviceSummary,
} from '@fabrikka/types';
import { LINK_TYPES } from '@fabrikka/types';
import {
  ApiError,
  connections,
  openStream,
  devices,
  sessions,
  teams,
  type SessionRef,
  type TokenSummary,
} from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { MentionComposer, MentionText } from '../mentions.tsx';
import { OutputsPanel, timeAgo, type OutputTab } from '../outputs/Outputs.tsx';
import { webKind } from '../outputs/kinds/registry.ts';
import { CatchUpCard, hasNews } from './CatchUpCard.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import type { NotifySetting } from '@fabrikka/types';

const NOTIFY_OPTIONS: { value: NotifySetting; label: string; description: string }[] = [
  { value: 'everything', label: '🔔 Everything', description: 'Every message from someone else' },
  { value: 'needs_you', label: '🔔 What needs me', description: 'Mentions, your agents finishing, a pause' },
  { value: 'nothing', label: '🔕 Nothing', description: 'Muted. Mentions still wait on Home' },
];

/** M42 (ADR 0037): how much of this room reaches you. Two clicks: open, choose. */
function RoomNotify({ ref_ }: { ref_: SessionRef }) {
  const { sessions: list, refresh } = useWorkspace();
  const here = list.find((s) => s.ownerSlug === ref_.owner && s.publicId === ref_.session);
  const [value, setValue] = useState<NotifySetting | null>(null);
  const current = value ?? here?.notify ?? 'needs_you';
  return (
    <Select
      className="room-notify"
      label="Notifications for this room"
      value={current}
      options={NOTIFY_OPTIONS}
      onChange={async (v) => {
        setValue(v);
        try {
          await sessions.setNotify(ref_, v);
          refresh();
        } catch {
          setValue(null);
        }
      }}
    />
  );
}

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
  const { user } = useAuth();
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
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null);
  const [commentsVersion, setCommentsVersion] = useState(0);
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
  /** "Show me" opens what the kind says: a paper's page, a document's diff. */
  const showTab = (e: OutputEditSummary): OutputTab =>
    webKind(outputs.find((o) => o.id === e.outputId)?.kind ?? '').showEditIn;
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

  // M24: show what changed since the last visit; with nothing new, just mark the
  // visit. Leaving marks it too — you were here, you saw the timeline.
  useEffect(() => {
    setCatchUp(null);
    sessions
      .catchUp(ref)
      .then((c) => {
        if (hasNews(c)) setCatchUp(c);
        else void sessions.seen(ref).catch(() => {});
      })
      .catch(() => {});
    // Most people leave by closing the tab or reloading, where React's cleanup
    // never runs; pagehide does.
    const leave = () => sessions.seenOnLeave(ref);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
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
          if (event.type === 'context.updated' || event.type === 'artifact.created' || event.type === 'links.changed') {
            // Panels own their own state; a bump is enough to make them refetch.
            setPanelsVersion((v) => v + 1);
          }
          if (event.type === 'output.changed') setOutputsVersion((v) => v + 1);
          if (event.type === 'comments.changed') setCommentsVersion((v) => v + 1);
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
  // M22: a teammate of a team-visible session, or a guest. They read; they don't
  // act. The server enforces that — this only stops offering what would fail.
  const isViewer = view.me.role === 'viewer';
  // M29 (ADR 0026): a chat is a light session — no output pane, a Setup with
  // only people and agents. A direct chat is titled by the other person.
  const kind = view.session.kind ?? 'session';
  const isChat = kind !== 'session';
  const peer = view.participants.find((p) => p.kind === 'human' && p.id !== view.me.participantId)?.displayName;
  const displayTitle = kind === 'chat' ? `#${view.session.title}` : kind === 'direct' ? (peer ?? 'Direct chat') : view.session.title;
  const outputOpen = panes.output && !isChat;

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
      <div
        className="workspace"
        // A viewer has no Setup (M22): never reserve its column, whatever was remembered.
        data-setup={panes.setup && !isViewer ? 'open' : 'closed'}
        data-output={outputOpen ? 'open' : 'closed'}
        data-doc={docOpen ? 'open' : 'closed'}
        style={{ '--rail-output-w': `${railWidth}px` } as React.CSSProperties}
      >
        {/*
          Left — SETUP: everything that CHANGES the session. Collapsible, because
          you add an agent once and then talk for an hour (ADR 0018).
        */}
        {!isViewer && (
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

          {!isChat && <IntegrationsPanel ref_={ref} isOwner={isOwner} />}

          <Panel title={`Members (${view.members.length})`}>
            <ul className="participants">
              {view.members.map((m) => (
                <li key={m.userId}>
                  <span>{m.displayName}</span>
                  <span className="muted small">
                    {m.role}
                    {m.viaTeam && <span title="Added from the team. Leaving the team ends this access."> · via team</span>}
                  </span>
                  {isOwner && m.userId !== user?.id && kind !== 'chat' && (
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

          {!isChat && isOwner && !!view.guests?.length && (
            <Panel title={`Guests (${view.guests.length})`}>
              <p className="muted small">They can read this session and nothing else.</p>
              <ul className="participants">
                {view.guests.map((g) => (
                  <li key={g.userId}>
                    <span>{g.displayName}</span>
                    <span className="muted small">view only</span>
                    <button
                      className="link small"
                      onClick={async () => {
                        await sessions.removeGuest(ref, g.userId);
                        reload();
                      }}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {!isChat && <TeamPanel ref_={ref} isOwner={isOwner} onChanged={reload} visibility={view.visibility} />}

          {!isChat && isOwner && <InvitesPanel ref_={ref} />}

          {!isChat && isOwner && (
            <Panel title="Settings">
              <div className="stack">
                <a className="link" href={sessions.exportUrl(ref)} download>
                  Export session
                </a>
                <p className="muted small">
                  A zip you can open anywhere: the decisions with who made them and when, every
                  document with its history, artifacts and the timeline. Once downloaded, it's out
                  of Fabrikka's hands.
                </p>
              </div>
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
        )}

        {/* Middle — the session happening. Never collapses; it is the product. */}
        <main className="session">
          <header>
            {!isViewer && (
              <button
                className={panes.setup ? 'pane-toggle on' : 'pane-toggle'}
                aria-expanded={panes.setup}
                title="Agents, members, integrations, invites"
                onClick={() => togglePane('setup')}
              >
                Setup
              </button>
            )}

            <h1>
              {displayTitle}{' '}
              {kind === 'chat' ? null : view.visibility === 'team' ? (
                <span title="Team-visible: everyone on the team can read along">👥</span>
              ) : (
                <span title="Private">🔒</span>
              )}
              {isViewer && <em className="badge">view only</em>}
              {view.session.status === 'archived' && <em className="badge">archived</em>}
            </h1>
            <span className={connected ? 'status on' : 'status off'}>
              {connected ? 'live' : 'reconnecting…'}
            </span>
            <span className="spacer" />
            {!isViewer && <RoomNotify ref_={ref} />}
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

            {isChat && !isViewer && <SpinOff ref_={ref} onDone={(to) => navigate(to)} />}
            {!isChat && (
              <button
                className={panes.output ? 'pane-toggle on' : 'pane-toggle'}
                aria-expanded={panes.output}
                title="What this session has produced: documents, context and files"
                onClick={() => togglePane('output')}
              >
                Output
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

          {catchUp && !catchUp.firstVisit && (
            <CatchUpCard
              c={catchUp}
              onDone={() => {
                setCatchUp(null);
                void sessions.seen(ref).catch(() => {});
              }}
            />
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
          {isViewer ? (
            <p className="viewer-note">
              You're viewing this session. You can read everything here as it happens, but not
              post, mention or edit.
            </p>
          ) : (
            <MentionComposer
              participants={view.participants}
              onSend={send}
              disabled={view.session.status === 'archived'}
              placeholder={
                view.session.status === 'archived'
                  ? 'This session is archived'
                  : kind === 'chat'
                    ? `Message #${view.session.title} — everyone on the team reads this, now and later`
                    : kind === 'direct'
                      ? `Message ${peer ?? ''}…  @ to mention an agent`
                      : 'Message everyone…  @ to mention'
              }
            />
          )}
        </main>

        {/*
          Right — OUTPUT: what the session PRODUCED. Context and artifacts are
          written by agents through MCP, so this pane is already filled by AI;
          it is filled by tool calls rather than by a button (ADR 0018).
        */}
        {/* A sibling of the rail, not a child: the rail scrolls, and a handle
            that scrolls away is a handle you cannot reach. */}
        {outputOpen && (
          <RailHandle
            width={railWidth}
            min={bounds.min}
            max={bounds.max}
            onResize={resizeOutput}
            onReset={resetOutputWidth}
          />
        )}

        {!isChat && (
        <aside className="rail output" aria-label="Session output" aria-hidden={!panes.output}>
          {(() => {
            const open = outputs.find((o) => o.id === panes.openOutput);
            // A viewer has no participant; their cursor identity is just their name.
            const me =
              view.participants.find((p) => p.id === view.me.participantId) ??
              (isViewer && user
                ? { id: `viewer-${user.id}`, sessionId: view.session.id, kind: 'human' as const, displayName: user.displayName }
                : undefined);
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
                    canDelete={!isViewer && (isOwner || open.createdBy.participantId === view.me.participantId)}
                    readOnly={isViewer}
                    tab={outputTab}
                    onTab={(t) => {
                      setOutputTab(t);
                      if (t !== 'history') setFocusEdit(null);
                    }}
                    focusEdit={focusEdit}
                    renameOnOpen={renameOnOpen}
                    editsVersion={outputsVersion}
                    commentsVersion={commentsVersion}
                    onClose={closeOutput}
                  />
                  </Suspense>
                </>
              );
            }
            return (
              <>
                <OutputsPanel ref_={ref} outputs={outputs} onOpen={(id, o) => openOutput(id, o)} canCreate={!isViewer} />
                <LinksPanel ref_={ref} version={panelsVersion} readOnly={isViewer} />
                <fieldset className="plain" disabled={isViewer}>
                  <ContextPanel key={`ctx-${panelsVersion}`} ref_={ref} />
                </fieldset>
                <ArtifactsPanel key={`art-${panelsVersion}`} ref_={ref} readOnly={isViewer} />
              </>
            );
          })()}
        </aside>
        )}

        {/*
          On a narrow screen the rails are overlays, so a backdrop is the way out.
          Hidden by CSS at desktop widths, where nothing overlaps anything.
        */}
        {((panes.setup && !isViewer) || outputOpen) && (
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
/**
 * The session's team, and adding a teammate without a link (M21, ADR 0025).
 * A team decides who can be added — never who can see.
 */
function TeamPanel({
  ref_,
  isOwner,
  onChanged,
  visibility,
}: {
  ref_: SessionRef;
  isOwner: boolean;
  onChanged: () => void;
  visibility: 'private' | 'team';
}) {
  const [team, setTeam] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [mine, setMine] = useState<TeamSummary[]>([]);
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    sessions.team(ref_).then(setTeam).catch(() => setTeam(null));
    if (isOwner) {
      teams.list().then(setMine).catch(() => {});
      sessions.roster(ref_).then(setRoster).catch(() => setRoster([]));
    }
  }, [ref_, isOwner]);
  useEffect(load, [load]);

  if (team === undefined) return null;
  // Nothing to show a member when there's no team; nothing to offer an owner on no team.
  if (!team && (!isOwner || mine.length === 0)) return null;

  const change = async (teamId: string) => {
    setError(null);
    if (team && teamId !== team.id && !window.confirm(
      'People added from the current team will lose access to this session. Continue?',
    )) return;
    try {
      setTeam(await sessions.setTeam(ref_, teamId || null));
      load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Panel title="Team">
      {isOwner ? (
        <Select
          label="Session team"
          value={team?.id ?? ''}
          options={[
            { value: '', label: 'No team', description: 'Only people you add' },
            ...mine.map((t) => ({ value: t.id, label: t.name, leading: <TeamInitial name={t.name} /> })),
          ]}
          onChange={(v) => change(v)}
        />
      ) : (
        <p className="small">{team!.name}</p>
      )}
      {isOwner && team && (
        <label className="check">
          <input
            type="checkbox"
            checked={visibility === 'team'}
            onChange={async (e) => {
              setError(null);
              try {
                await sessions.update(ref_, { visibility: e.target.checked ? 'team' : 'private' });
                onChanged();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
          <span>
            Everyone on {team.name} can read along
            <span className="muted small"> — they see the timeline and documents, but can't post or edit</span>
          </span>
        </label>
      )}
      {isOwner && team && (
        <>
          <p className="muted small">
            {roster.length ? 'Add a teammate — no link needed:' : 'Everyone on the team is already here.'}
          </p>
          <ul className="participants">
            {roster.map((m) => (
              <li key={m.userId}>
                <span>{m.displayName}</span>
                <button
                  className="link small"
                  onClick={async () => {
                    setError(null);
                    try {
                      await sessions.addFromRoster(ref_, m.userId);
                      load();
                      onChanged();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </Panel>
  );
}

function InvitesPanel({ ref_ }: { ref_: SessionRef }) {
  const [list, setList] = useState<InviteSummary[]>([]);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [scopeEmail, setScopeEmail] = useState('');
  const [guest, setGuest] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    sessions.invites(ref_).then(setList).catch(() => {});
  }, [ref_]);

  useEffect(refresh, [refresh]);

  const create = async () => {
    setError(null);
    try {
      const created = await sessions.createInvite(ref_, {
        ...(scopeEmail.trim() ? { invitedEmail: scopeEmail.trim() } : {}),
        ...(guest ? { role: 'guest' as const } : {}),
      });
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
        <label className="check">
          <input type="checkbox" checked={guest} onChange={(e) => setGuest(e.target.checked)} />
          <span>
            Guest — view only
            <span className="muted small"> (a client, an advisor: reads this session, nothing else)</span>
          </span>
        </label>
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
  // M31: agents that run on your own computer, in a folder granted there.
  const [myDevices, setMyDevices] = useState<DeviceSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState<string>('');
  const [tool, setTool] = useState('');
  const [caveatOk, setCaveatOk] = useState(false);
  const [hosts, setHosts] = useState<Record<string, { deviceName: string; label: string | null; online: boolean }>>({});

  const refresh = useCallback(() => {
    sessions.agents(ref_).then(setAgents).catch(() => {});
    sessions.agentHosts(ref_).then(setHosts).catch(() => {});
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

  const folders = (myDevices ?? []).flatMap((d) =>
    d.grants.filter((g) => g.usable).map((g) => ({
      key: `${d.id}|${g.id}`,
      deviceId: d.id,
      grantId: g.id,
      device: d.name,
      label: g.label,
      online: d.online,
      // M37: the agent tools that computer offers (its own choice), known to the registry.
      tools: g.providers.filter((p) => agentTool(p)),
    })),
  );
  const chosen = folders.find((x) => x.key === choice) ?? folders[0];
  // The tool: asked only when the computer has both; otherwise whichever it has.
  const toolFor = (f: (typeof folders)[number] | undefined) => (f?.tools.includes(tool) ? tool : f?.tools[0]);
  const effectiveTool = toolFor(chosen);
  // A tool's caveat (Codex's, ADR 0032) needs a confirming tick before Add.
  const caveat = effectiveTool ? agentTool(effectiveTool)?.caveat : undefined;
  const needsCaveatOk = !!caveat && !caveatOk;

  const addMine = async () => {
    const f = chosen;
    if (!f || needsCaveatOk) return;
    setError(null);
    try {
      await sessions.addHostAgent(ref_, { deviceId: f.deviceId, grantId: f.grantId, provider: effectiveTool });
      setPicking(false);
      refresh();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Panel title="Agents">
      {/* The five-click path (CLAUDE.md): Setup → Add my agent → folder → Add. */}
      {!picking ? (
        <button
          className="primary"
          onClick={() => {
            setPicking(true);
            devices.list().then((d) => {
              setMyDevices(d);
              const first = d.flatMap((x) => x.grants.filter((g) => g.usable).map((g) => `${x.id}|${g.id}`))[0];
              setChoice(first ?? '');
            }).catch(() => setMyDevices([]));
          }}
        >
          Add my agent
        </button>
      ) : (
        <div className="stack add-mine">
          {myDevices === null && <p className="muted small">Looking for your computers…</p>}
          {myDevices !== null && folders.length === 0 && (
            <p className="muted small">
              {myDevices.length === 0 ? (
                <>
                  Run your agent on your own computer: connect it once from <Link to="/devices">Your devices</Link>{' '}
                  (one command to paste), then grant a folder there.
                </>
              ) : (
                <>
                  No folder granted yet on {myDevices.map((d) => d.name).join(', ')}.{' '}
                  {inDesktopApp() ? (
                    <button className="link small" onClick={() => openFolders().catch(() => {})}>
                      Add folders…
                    </button>
                  ) : (
                    <>On that computer: the Fabrikka app's menu-bar icon → Folders….</>
                  )}
                </>
              )}
            </p>
          )}
          {folders.length > 0 && (
            <>
              <p className="muted small">Run in which folder?</p>
              {folders.map((f) => (
                <label key={f.key} className="check">
                  <input type="radio" name="folder" checked={choice === f.key} onChange={() => setChoice(f.key)} />
                  <span>
                    📁 {f.label} <span className="muted small">on {f.device}{f.online ? '' : ' (offline)'}</span>
                  </span>
                </label>
              ))}
              {chosen && chosen.tools.length > 1 && (
                // M37: as many tools as the computer offers, in the app's own selector.
                <div className="tool-choice">
                  <span className="muted small">Which agent?</span>
                  <Select
                    label="Agent tool"
                    value={effectiveTool ?? ''}
                    options={chosen.tools.map((t) => ({ value: t, label: agentTool(t)?.name ?? t }))}
                    onChange={(t) => {
                      setTool(t);
                      setCaveatOk(false);
                    }}
                  />
                </div>
              )}
              {caveat && (
                // Said where the tool is chosen (ADR 0032 for Codex), from the registry.
                <label className="check codex-caveat">
                  <input type="checkbox" checked={caveatOk} onChange={(e) => setCaveatOk(e.target.checked)} />
                  <span className="small">
                    <strong>I understand:</strong> {caveat}
                  </span>
                </label>
              )}
              <button onClick={addMine} disabled={needsCaveatOk}>
                Add
              </button>
            </>
          )}
          <button className="link small" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      )}

      <details className="manual-agent">
        <summary className="muted small">Connect another way (another tool, or by hand)</summary>
      <form className="stack" onSubmit={add}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="agent name, e.g. claude-fede"
          aria-label="Agent name"
        />
        <Select
          label="Agent tool"
          value={provider}
          options={[
            // M37: the registry's tools, plus anything else that speaks MCP.
            ...AGENT_TOOLS.map((t) => ({ value: t.id, label: t.name })),
            { value: 'other', label: 'Other MCP agent', description: 'Anything that speaks MCP' },
          ]}
          onChange={(v) => setProvider(v)}
        />
        <button type="submit" disabled={!name.trim()}>
          Add agent
        </button>
      </form>

      {fresh && <AgentSetup created={fresh} onError={setError} />}
      </details>

      {error && <p className="error small">{error}</p>}

      {agents.length > 0 && (
        <ul className="participants">
          {agents.map((a) => (
            <li key={a.sessionAgentId}>
              <span>🤖 @{a.displayName}</span>
              <span className="muted small">
                {hosts[a.participantId]
                  ? `on ${hosts[a.participantId]!.deviceName} · ${hosts[a.participantId]!.label ?? 'folder removed'}${hosts[a.participantId]!.online ? '' : ' · offline'}`
                  : a.provider}
              </span>
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
                <strong>Runs start without approval prompts, in Edit in folder</strong>: Codex
                changes only that folder, with no network and none of your other Codex
                tools — but it can read files anywhere on this computer. Only mentions
                from you can trigger them.
              </>
            ) : (
              <>
                <strong>Runs start without permission prompts, in Edit in folder
                mode</strong>: they read and edit files in that folder only, with no
                shell and no web. Add <code>--policy full</code> for an agent that
                needs to run commands, such as tests. Only mentions from you can
                trigger them.
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

const LINK_ICON: Record<LinkType, string> = {
  issue: '🎫',
  pr: '🔀',
  repo: '📦',
  page: '📘',
  dashboard: '📈',
  error: '🐞',
};

/**
 * What this session is about, outside it (M19). Pointers, never copies: the
 * status is whatever was last reported, with its age, because Fabrikka never
 * polls a vendor and should not look as if it did.
 */
function LinksPanel({ ref_, version, readOnly = false }: { ref_: SessionRef; version: number; readOnly?: boolean }) {
  const [list, setList] = useState<SessionLink[]>([]);
  const [url, setUrl] = useState('');
  const [type, setType] = useState<LinkType>('issue');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    sessions.links(ref_).then(setList).catch(() => {});
  }, [ref_]);
  // Reload on any change, but never remount: someone else's link must not wipe
  // the URL you are halfway through typing.
  useEffect(load, [load, version]);

  const add = async () => {
    if (!url.trim()) return;
    setError(null);
    try {
      await sessions.saveLink(ref_, { url: url.trim(), type });
      setUrl('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Panel title="Links">
      {list.length === 0 && (
        <p className="muted small">Tickets, PRs, repos and docs this session is about. Agents add them too.</p>
      )}
      {list.length > 0 && (
        <ul className="links-list">
          {list.map((l) => (
            <li key={l.url}>
              <span aria-label={l.type} title={l.type}>{LINK_ICON[l.type]}</span>
              <span className="link-text">
                <a href={l.url} target="_blank" rel="noreferrer noopener">
                  {l.title ?? l.url}
                </a>
                <span className="muted small">
                  {l.provider}
                  {l.status && (
                    <>
                      {' · '}
                      <strong>{l.status}</strong>
                      {l.statusAt && ` · ${timeAgo(l.statusAt)}`}
                    </>
                  )}
                </span>
              </span>
              {!readOnly && (
              <button
                className="link small"
                aria-label={`Unlink ${l.title ?? l.url}`}
                onClick={async () => {
                  await sessions.removeLink(ref_, l.url).catch(() => {});
                  load();
                }}
              >
                ×
              </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
      <div className="link-add">
        <Select
          label="Link type"
          value={type}
          options={LINK_TYPES.map((t) => ({ value: t, label: t === 'pr' ? 'PR' : t[0]!.toUpperCase() + t.slice(1) }))}
          onChange={(v) => setType(v as LinkType)}
        />
        <input
          value={url}
          placeholder="Paste a URL and press Enter"
          aria-label="Link URL"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
      </div>
      )}
      {error && <p className="error small">{error}</p>}
    </Panel>
  );
}

function ArtifactsPanel({ ref_, readOnly = false }: { ref_: SessionRef; readOnly?: boolean }) {
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
      {!readOnly && (
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
      )}

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
              {!readOnly && (
              <button
                className="link small"
                onClick={async () => {
                  await sessions.deleteArtifact(ref_, a.id);
                  load();
                }}
              >
                remove
              </button>
              )}
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
  // M18: which of my connections come from a catalogue entry with grant presets.
  const [presetSlugs, setPresetSlugs] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    sessions.integrations(ref_).then(setState).catch(() => {});
    connections
      .list()
      .then(async (mine) => {
        const cat = await connections.catalogue();
        const withPresets = new Set(cat.entries.filter((e) => e.presets).map((e) => e.id));
        setPresetSlugs(new Set(mine.connections.filter((c) => c.entry && withPresets.has(c.entry)).map((c) => c.slug)));
      })
      .catch(() => {});
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
      {state.available.length > 0 && (
        <div className="stack">
          <p className="muted small">Your connections — attach one to this session:</p>
          <ul className="participants">
            {state.available.map((a) => (
              <li key={a.id}>
                <span>{a.label}</span>
                <span className="muted small">{a.slug}</span>
                <button
                  className="link small"
                  onClick={async () => {
                    setError(null);
                    try {
                      await sessions.attachIntegration(ref_, { slug: a.slug });
                      load();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  attach
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
                {isOwner && presetSlugs.has(m.slug) && (
                  // M18: a shortcut over the per-tool grants, never a new permission model.
                  <span className="preset-buttons" role="group" aria-label={`What agents may do with ${m.label}`}>
                    {(['none', 'read', 'write'] as const).map((p) => (
                      <button
                        key={p}
                        className="link small"
                        onClick={async () => {
                          await sessions.setPreset(ref_, m.slug, p).catch((err) => setError((err as Error).message));
                          load();
                        }}
                      >
                        {p === 'none' ? 'Allow nothing' : p === 'read' ? 'Read' : 'Read & write'}
                      </button>
                    ))}
                  </span>
                )}
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

      {state.team.length > 0 && (
        <>
          <h3 className="subhead">{state.team[0]!.teamName}'s</h3>
          <ul className="participants">
            {state.team.map((t) => (
              <li key={t.slug}>
                <span>{t.label}</span>
                {t.overridden ? (
                  <span className="muted small" title="Your own connection with this name is used instead">
                    you use your own
                  </span>
                ) : (
                  <span className="badge-shared" title="Calls run as the team's account, not yours">
                    team's · shared
                  </span>
                )}
                <button
                  className="link small"
                  onClick={async () => {
                    const list = await sessions.integrationTools(ref_, t.slug);
                    setTools((x) => ({ ...x, [t.slug]: list }));
                  }}
                >
                  tools
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
            in the session — each person uses their own credential, or the team's
            shared one where they have none.
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
  meParticipantId: string | null;
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
                meParticipantId={meParticipantId ?? undefined}
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


/**
 * Start a session from a chat (M29): when a thread becomes real work. The new
 * session opens with a link back here; nothing is copied, the chat keeps its history.
 */
function SpinOff({ ref_, onDone }: { ref_: SessionRef; onDone: (to: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  if (!open) {
    return (
      <button
        className="link"
        title="When a thread becomes real work: a new session that links back here. Nothing is copied."
        onClick={() => setOpen(true)}
      >
        Start a session from this
      </button>
    );
  }
  return (
    <form
      className="spin-off"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const s = await sessions.spinOff(ref_, title.trim());
        onDone(`/o/${s.ownerSlug}/s/${s.publicId}`);
      }}
    >
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="New session title" />
      <button type="submit" disabled={!title.trim()}>
        Start
      </button>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
