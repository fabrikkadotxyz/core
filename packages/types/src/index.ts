/**
 * Shared domain types.
 *
 * Deliberately contains NO MCP SDK types. The remote endpoint speaks MCP v2 and
 * the bridge speaks v1 (see docs/decisions/0005-two-sdk-generations.md); an
 * abstraction spanning both could only express their intersection, which would
 * hide the constraint that most needs to stay visible.
 */

/** Humans and agents are the same kind of thing: a participant in a session. */
export type ParticipantKind = 'human' | 'agent';

export type SessionStatus = 'active' | 'archived';

/** Only a `bridge` connection can receive a claude/channel push. */
export type ConnectionKind = 'bridge' | 'remote_http';

export type ConnectionStatus = 'connected' | 'working' | 'blocked' | 'idle' | 'offline';
/** M15 slice 1: why an agent is blocked, where it reported one. An unknown value is shown as "waiting". */
export type BlockedReason = 'permission' | 'elicitation' | 'input';

export interface Participant {
  id: string;
  sessionId: string;
  kind: ParticipantKind;
  displayName: string;
  /** Absent for humans and for agents with no live connection. */
  status?: ConnectionStatus;
  /** M15 slice 1: with `blocked`, what the agent waits on (reason, redacted detail). */
  blocked?: { reason: string | null; detail: string | null } | null;
}

/**
 * A resolved mention. `displayName` is looked up at read time, so a rename is
 * reflected in messages written before it.
 */
export interface Mention {
  participantId: string;
  displayName: string;
  kind: ParticipantKind;
}

export interface Message {
  id: string;
  sessionId: string;
  author: {
    participantId: string;
    kind: ParticipantKind;
    displayName: string;
  };
  /**
   * Content in canonical form, containing `<@participant_id>` markers.
   *
   * NOT directly displayable — render the markers using `mentions`. The MCP
   * projection expands them to `@display_name` instead; same storage, different
   * rendering. See docs/decisions/0008-mentions-as-stable-markers.md.
   */
  content: string;
  /** Derived from the markers in `content`, never supplied alongside it. */
  mentions: Mention[];
  createdAt: string;
}

export interface Session {
  id: string;
  /** Public id. Appears in the MCP endpoint path. Never the internal PK. */
  publicId: string;
  /** Owner's public slug. Appears in the MCP endpoint path. Never users.id. */
  ownerSlug: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  /** session | chat | direct (M29, ADR 0026). Absent means session. */
  kind?: SessionKind;
  /** The team it belongs to, if any. */
  teamId?: string | null;
}

/** A chat is a light session (ADR 0026): same engine, shown lighter. */
export type SessionKind = 'session' | 'chat' | 'direct';

/* -------------------------------------------------------------------------- */
/* Realtime: browser <-> server                                               */
/* -------------------------------------------------------------------------- */

/**
 * Server -> client.
 *
 * `stream.error` is sent as a normal frame before the socket closes. WebSocket
 * close codes do not reliably survive a close issued during the upgrade, so the
 * reason a stream was refused is carried in-band rather than in the close code.
 * A client that sees this must NOT reconnect.
 */
export type ServerEvent =
  | {
      type: 'hello';
      sessionId: string;
      participants: Participant[];
      /** Runs in flight, and their buffered activity, so a late joiner catches up. */
      runs?: Run[];
      activity?: ActivityEvent[];
    }
  | { type: 'message.created'; message: Message }
  | { type: 'participant.updated'; participant: Participant }
  | { type: 'context.updated'; context: SessionContext }
  | { type: 'artifact.created'; artifact: Artifact }
  /** An output was created, renamed or removed. Panels refetch. See ADR 0019. */
  | { type: 'output.changed'; outputId: string }
  /** A link was added, updated or removed. Clients re-read /links. See M19. */
  | { type: 'links.changed' }
  /** A comment on that output changed (M23). Display data: it wakes no agent. */
  | { type: 'comments.changed'; outputId: string }
  /**
   * An output's content changed. Display data only, like activity: it is not a
   * message, wakes no agent and costs no turn budget (ADR 0019).
   */
  | { type: 'output.edited'; edit: OutputEditSummary }
  | { type: 'run.started'; run: Run }
  | { type: 'run.ended'; run: Run }
  | { type: 'activity'; event: ActivityEvent }
  | {
      /**
       * A mention that did NOT reach an agent, and why. Emitted so a human can
       * see that someone addressed an agent and nothing happened — silent
       * non-delivery is indistinguishable from a bug. See ADR 0010.
       */
      type: 'mention.blocked';
      messageId: string;
      participantId: string;
      displayName: string;
      reason:
        | 'own_message'
        | 'not_trusted'
        | 'no_connection'
        | 'paused'
        | 'turn_budget';
    }
  | {
      type: 'presence.updated';
      participantId: string;
      status: ConnectionStatus;
      /** M15 slice 1: with `blocked`, why and (redacted) on what. */
      reason?: BlockedReason | null;
      detail?: string | null;
      /** M15 slice 1: with `idle`, true when a unit of work just finished. */
      completed?: boolean;
    }
  | {
      /** Agents halted, by a human or by the turn budget. See ADR 0012. */
      type: 'agents.paused';
      paused: boolean;
      reason: 'manual' | 'turn_budget' | null;
    }
  | { type: 'stream.error'; code: 'unauthenticated' | 'not_found' };

/** Client -> server. M0 posts over HTTP; the socket is read-only for now. */
export type ClientEvent = { type: 'ping' };

/* -------------------------------------------------------------------------- */
/* HTTP API                                                                   */
/* -------------------------------------------------------------------------- */

export interface PostMessageBody {
  content: string;
  /**
   * Participant ids the composer resolved by autocomplete. Optional: bare
   * `@name` tokens in `content` are resolved server-side, which is how agents
   * posting prose over MCP produce real mentions without knowing ids.
   */
  mentions?: string[];
}

export interface RenameParticipantBody {
  displayName: string;
}

/* -------------------------------------------------------------------------- */
/* M3 — agents, tokens, session context                                       */
/* -------------------------------------------------------------------------- */

/**
 * How much authority a message's author has over the agent reading it.
 *
 * Evaluated per reader: the same message is `owner` to the agent its author owns
 * and `untrusted` to every other agent in the room. Anything below `owner` is
 * data, never instructions. See docs/security.md.
 */
export type TrustTier = 'owner' | 'session' | 'untrusted';

/** Default is `owner_only`: only an agent's own owner can direct it. */
export type AgentTrustPolicy = 'owner_only' | 'session_trusted';

export interface AgentSummary {
  participantId: string;
  sessionAgentId: string;
  displayName: string;
  provider: string;
  trustTier: AgentTrustPolicy;
  /** Whether this agent's steps stream to the session (ADR 0015). */
  activityVisible: boolean;
  ownerUserId: string;
}

/**
 * How an agent can be attached.
 *
 * - `bridge` — real-time push into a session that is already running. Claude Code
 *   only: `claude/channel` is proprietary and stdio-only.
 * - `runner`  — spawn a headless run per mention. Claude Code, Codex and OpenCode.
 * - `remote`  — plain MCP client, pull-only. Anything that speaks MCP.
 */
export type SetupLane = 'bridge' | 'runner' | 'remote' | 'command';

/**
 * Setup instructions, generated per provider.
 *
 * `lanes` lists only what actually works for this agent's provider, best first.
 * Showing a lane a provider cannot use is worse than showing nothing: it sends
 * someone to debug a setup that was never going to work.
 */
export interface AgentSetupView {
  lanes: SetupLane[];
  /** Pull-only. Phrased for this provider's own CLI. */
  remoteCommand: string;
  /** `.mcp.json` for the agent's project directory. Null unless `bridge`. */
  bridgeMcpJson: string | null;
  /** Starts the agent with the channel opted in. Null unless `bridge`. */
  bridgeCommand: string | null;
  /** Starts a runner. Null unless `runner`. Running it is the consent (ADR 0011). */
  runnerCommand: string | null;
  /** ADR 0054: runs any command as this agent, Full policy only. Null unless `command`. */
  commandCommand?: string | null;
}

/** Returned once, at creation. The token is never recoverable afterwards. */
export interface CreatedAgentView {
  agent: AgentSummary;
  token: string;
  mcpUrl: string;
  setup: AgentSetupView;
}

/**
 * Whether agents are halted, and how much budget is left.
 *
 * `paused` guarantees no further work is SENT. It does not guarantee that work
 * already running has stopped — see ADR 0012.
 */
export interface PauseState {
  paused: boolean;
  reason: 'manual' | 'turn_budget' | null;
  pausedAt: string | null;
  turnsUsed: number;
  turnLimit: number;
}

export interface SessionContext {
  objective: string | null;
  facts: string[];
  decisions: string[];
  questions: string[];
  constraints: string[];
  /** Increments on every write. Send it back to replace a list safely. */
  version: number;
  updatedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* M10 — runs and live activity                                               */
/* -------------------------------------------------------------------------- */

export type RunKind = 'channel' | 'spawn';
export type RunStatus = 'running' | 'done' | 'stopped' | 'failed';

export interface Run {
  id: string;
  participantId: string;
  displayName: string;
  kind: RunKind;
  provider: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  /** ADR 0054: the first word of the resume argv the run reported, or null. Never the whole argv. */
  resumeWith?: string | null;
}

/**
 * One step an agent took, as a SUMMARY.
 *
 * `tool` is the tool's name; `detail` is one short descriptor, already redacted on
 * the runner before it was sent. Tool OUTPUT is never carried here, and neither
 * are full command lines. See ADR 0015.
 *
 * Inert display data: never delivered to another agent, never counted against the
 * turn budget.
 */
export interface ActivityEvent {
  runId: string;
  participantId: string;
  displayName: string;
  tool: string;
  detail: string | null;
  at: string;
}

export type ArtifactType = 'file' | 'link';

export interface Artifact {
  id: string;
  type: ArtifactType;
  name: string;
  contentType: string | null;
  sizeBytes: number | null;
  /** Present for links; a file is fetched through the artifact endpoint. */
  url: string | null;
  createdBy: { participantId: string; displayName: string };
  createdAt: string;
}

/* ------------------------------------------------------------------ outputs */

/**
 * A kind of output — a registered kind id. The catalogue, not this type, is the
 * list: which kinds exist is decided by the instance at runtime (ADR 0023).
 */
export type OutputKind = string;

/** A catalogue entry. See ADR 0019. */
export interface OutputKindInfo {
  kind: OutputKind;
  name: string;
  description: string;
  icon: string;
  /** What a new one is called before anyone names it. */
  defaultName: string;
  /** False when the instance lacks something the kind needs. */
  available: boolean;
  /** Whether the kind holds several files (a paper's sections, its .bib). */
  multiFile: boolean;
}

export interface Output {
  id: string;
  kind: OutputKind;
  name: string;
  files: string[];
  mainFile: string;
  version: number;
  createdBy: { participantId: string; displayName: string };
  createdAt: string;
  updatedAt: string;
  /** Who changed it most recently, for the list. */
  lastEdit: { displayName: string; at: string } | null;
}

export interface OutputEditSummary {
  id: string;
  outputId: string;
  outputName: string;
  file: string;
  participantId: string | null;
  displayName: string;
  participantKind: 'human' | 'agent' | null;
  runId: string | null;
  version: number;
  added: number;
  removed: number;
  /** Lines of the file this edit touched, after the edit — for "show me". */
  lines: { start: number; end: number } | null;
  at: string;
}

export interface OutputEdit extends OutputEditSummary {
  /** Unified diff of the lines this participant changed. */
  diff: string;
}

/** latex only: what the last viewer's compile found. See ADR 0020. */
export interface BuildReport {
  status: 'ok' | 'failed' | 'unknown';
  version: number | null;
  at: string | null;
  /** Browsers with the output open: >0 means a compile is seconds away. */
  viewers: number;
  errors: BuildError[];
}

export interface BuildError {
  file: string;
  line: number | null;
  message: string;
}

/** Where a viewer's browser loads the TeX engine from. See ADR 0020. */
export interface TexConfig {
  assetsPath: string;
}

export interface SessionView {
  session: Session;
  /** Whether agents are halted, and remaining budget. See ADR 0012. */
  agents: PauseState;
  participants: Participant[];
  members: Member[];
  /**
   * The requesting user's role and participant identity in this session. A
   * viewer (M22: a teammate of a team-visible session, or a guest) has role
   * `viewer` and no participant: they read, they don't act.
   */
  me: { role: SessionRole | 'viewer'; participantId: string | null };
  /** private | team (M22). */
  visibility: SessionVisibility;
  /** Guests of this session (M22) — present for owners only. */
  guests?: { userId: string; displayName: string; email: string }[];
  /** The ready-to-paste `claude mcp add` command. See docs/protocol.md. */
  mcpEndpoint: string;
}

/* -------------------------------------------------------------------------- */
/* M1 — auth, membership, invites                                             */
/* -------------------------------------------------------------------------- */

export type SessionRole = 'owner' | 'member';

/** Who beyond its members can see a session (M22, ADR 0025). Never "public". */
export type SessionVisibility = 'private' | 'team';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  ownerSlug: string;
  isInstanceOwner: boolean;
}

export interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: SessionRole;
  /** True when this access came from the team roster (M21): leaving the team ends it. */
  viaTeam?: boolean;
  /** M50: their participant in this session, so People is one list; null for a member with no participant yet. */
  participantId?: string | null;
  /** M50: the name they go by in this session (a rename is per session). */
  participantName?: string | null;
}

export interface SessionSummary {
  publicId: string;
  ownerSlug: string;
  title: string;
  status: SessionStatus;
  /** `viewer`: you can read it because it's team-visible, or you're a guest (M22). */
  role: SessionRole | 'viewer';
  memberCount: number;
  createdAt: string;
  /** The organization it belongs to (M21). Every session has one since M53 (ADR 0051); only a direct message has none. */
  team?: { id: string; name: string } | null;
  /** M53: private and only you in it (one member, no guest). Derived on listing. */
  individual?: boolean;
  /** The latest message, or creation if there is none (M28). */
  lastActivityAt?: string;
  /** session | chat | direct (M29). */
  kind?: SessionKind;
  /** Direct chats: the other person's name. */
  peer?: string | null;
  /** Messages from someone else since your last visit (M24's read position). */
  unread?: boolean;
  /**
   * M42 (ADR 0037): items addressed to you since your last visit — mentions,
   * a direct message, your agent finishing or stopping, a pause you can resume.
   */
  needsYou?: number;
  /** M42: this room's setting for you, with its kind's default applied. */
  notify?: NotifySetting;
}

/** M42: how much of a room reaches you. */
export type NotifySetting = 'everything' | 'needs_you' | 'nothing';

/** M42: what /api/me/stream sends. */
export type PersonEvent =
  | { type: 'attention'; ownerSlug: string; publicId: string; unread: boolean; needsYou: number }
  | { type: 'notify'; ownerSlug: string; publicId: string; title: string; body: string; path: string }
  | { type: 'stream.error'; code: 'unauthenticated' };

/**
 * An invite as shown to a session owner. Deliberately carries no token — the
 * plaintext is returned once at creation and is never recoverable (ADR 0007).
 */
export interface InviteSummary {
  id: string;
  role: SessionRole;
  /** Optional scope. When set, only this address may redeem. Nothing is sent. */
  invitedEmail: string | null;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned once, at creation. `url` is what the UI puts on the clipboard. */
export interface CreatedInviteView {
  invite: InviteSummary;
  token: string;
  url: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

/** Signup always carries an invite token: there is no open registration. */
export interface SignupBody {
  token: string;
  email: string;
  password: string;
  displayName: string;
}

/* -------------------------------------------------------------------- links */

/** What a link points at. See docs/protocol.md (M19). */
export const LINK_TYPES = ['issue', 'pr', 'repo', 'page', 'dashboard', 'error'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** A pointer to something outside the session. Never a copy. */
export interface SessionLink {
  type: LinkType;
  provider: string;
  url: string;
  title: string | null;
  /** As last reported. Fabrikka never polls a vendor. */
  status: string | null;
  statusAt: string | null;
  addedBy: string | null;
  updatedAt: string;
}

/* -------------------------------------------------------------------- teams */

/** See ADR 0025. Owners invite and remove; that is the only difference. */
export type TeamRole = 'owner' | 'member';

export interface TeamSummary {
  id: string;
  name: string;
  role: TeamRole;
  memberCount: number;
  /** M53 (ADR 0051): the caller's own organization, made with their account. Listed first; cannot be left. */
  own?: boolean;
  /** A deployment's notice on this team (ADR 0041), e.g. a limit it set. */
  notice?: TeamNotice | null;
}

/** Short plain text, an optional link (a path on the instance, or http(s)), and a tone. */
export interface TeamNotice {
  text: string;
  url?: string;
  tone: 'info' | 'attention';
}

export interface TeamMember {
  userId: string;
  displayName: string;
  email: string;
  role: TeamRole;
}

export interface TeamDetail {
  id: string;
  name: string;
  /** The viewer's role. */
  role: TeamRole;
  members: TeamMember[];
}

/* ------------------------------------------------------------------ comments */

/** A thread on an output, anchored to a quoted passage (M23). */
export interface OutputComment {
  id: string;
  file: string;
  quote: string;
  body: string;
  author: string;
  createdAt: string;
  status: 'open' | 'resolved';
  /** The quote no longer occurs exactly once: someone rewrote the passage. */
  outdated: boolean;
  /** Who resolved it: a person, or the agent whose edit did. */
  resolvedBy: string | null;
  /** Set when an agent's edit resolved it: the output version that did. */
  resolvedAtVersion: number | null;
  replies: { id: string; body: string; author: string; createdAt: string }[];
}

/* ------------------------------------------------------------------ catch-up */

/** What changed in a session since you last looked (M24). Built from the record. */
export type CatchUp =
  | { firstVisit: true; since: null }
  | {
      firstVisit: false;
      since: string;
      decisions: string[];
      facts: string[];
      newQuestions: string[];
      /** Open at your last visit, not open now. */
      answeredQuestions: string[];
      messages: number;
      mentions: { from: string; text: string; at: string }[];
      /** `isNew`: created while you were away. */
      outputs: { name: string; editors: string[]; edits: number; isNew?: boolean }[];
      links: { title: string; url: string; status: string }[];
    };

/** A mention of you, in any of your sessions, since you last opened it (M24). */
export interface WaitingItem {
  session: { ownerSlug: string; publicId: string; title: string };
  from: string;
  text: string;
  at: string;
}

/** M56: the home, derived on each visit from what the server records. Every item names its room. */
export interface HomeView {
  /** Mentions of you since you last looked (M24). */
  needsYou: WaitingItem[];
  /** Runs in progress in rooms you are in, with the latest step when its owner shows activity. */
  running: { id: string; agent: string; provider: string | null; startedAt: string; session: WaitingItem['session']; last: { tool: string; detail: string | null; at: string } | null; /** M15 slice 1: the agent reported it is waiting on a person. */ blocked?: { reason: BlockedReason | string; detail: string | null } | null }[];
  /** Your agents' runs that ended since you last looked at their room. */
  finished: { id: string; agent: string; status: 'done' | 'failed' | 'stopped'; endedAt: string; session: WaitingItem['session'] }[];
  /** Rooms with messages from someone else since you last looked. */
  changed: { session: WaitingItem['session']; messages: number; lastAt: string }[];
  /** Rooms where the last word is yours and mentions a person. */
  waitingOnOthers: { session: WaitingItem['session']; to: string; text: string; at: string }[];
  /** One-off session links you sent that nobody has opened (Self). */
  openInvites: { id: string; session: WaitingItem['session']; createdAt: string; expiresAt: string }[];
  /** Your paired computers, with how many agents each runs. */
  computers: { id: string; name: string; online: boolean; agents: number }[];
}

/* ----------------------------------------------------------------- templates */

/** A session's structure, never its content (M25). */
export interface TemplateBody {
  objective: string;
  constraints: string[];
  /** Starter open questions. */
  questions: string[];
  /** Starter outputs: a pitch with empty sections, an incident report's headings. */
  outputs: { kind: string; name: string; content: string }[];
  /** Connection categories worth adding: "issue tracker", "observability"… */
  connections: string[];
}

export interface TemplateSummary {
  /** "builtin:<id>" for a built-in, or a saved template's id. */
  ref: string;
  name: string;
  description: string;
  /** Where it comes from: Fabrikka, you, or a team you're on. */
  source: 'builtin' | 'mine' | 'team';
  teamName?: string;
  /** True when you may delete it. */
  canDelete: boolean;
  body: TemplateBody;
}

/* ------------------------------------------------------------- local host */

/** A paired machine running the host (M31, ADR 0027). Labels only, never paths. */
export interface DeviceSummary {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  grants: {
    id: string;
    label: string;
    providers: string[];
    /** False when none of its agent tools has verified host policies (Codex, for now). */
    usable: boolean;
    /** ADR 0043: the organization whose rooms may use it (chosen on the machine); null for Personal. */
    org: string | null;
  }[];
}

/* -------------------------------------------------------------------------- */
/* M37 — agent tools                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every agent tool the local host can run, in one place (M37). The web app's
 * picker, the server and the host all read this list; nothing else names a
 * tool. Adding one = an entry here + its policy flags in the runner (spawn.ts).
 * Which of these a given computer OFFERS is decided on that computer.
 */
export interface AgentTool {
  /** Stable id, as stored on bindings and grants: "claude-code", "codex". */
  id: string;
  name: string;
  /** What the host looks for on the PATH to call it installed. */
  command: string;
  /** Shown in the picker, with a confirming tick, when this tool is chosen. */
  caveat?: string;
}

export const AGENT_TOOLS: readonly AgentTool[] = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude' },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    // ADR 0032: its sandbox confines writes, network and its other tools — not reads.
    caveat:
      'Codex can read files anywhere on this computer. In Read only and Edit-in-folder folders it changes nothing outside the folder, has no network, and none of your other Codex tools.',
  },
  // ADR 0047: confined by a per-run permission config, reads included; no caveat.
  { id: 'opencode', name: 'OpenCode', command: 'opencode' },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    // ADR 0055: plan and accept-edits confine reads and writes, but deny the session's tools in headless mode.
    caveat:
      'In Read only and Edit in folder, Antigravity cannot use the session’s tools; its answer is posted for it. Full gives it the tools, after `agy mcp add -- fabrikka fabrikka connect` once on this computer.',
  },
];

export const agentTool = (id: string): AgentTool | undefined => AGENT_TOOLS.find((t) => t.id === id);
