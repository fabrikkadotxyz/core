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

export type ConnectionStatus = 'connected' | 'working' | 'idle' | 'offline';

export interface Participant {
  id: string;
  sessionId: string;
  kind: ParticipantKind;
  displayName: string;
  /** Absent for humans and for agents with no live connection. */
  status?: ConnectionStatus;
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
}

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
  | { type: 'presence.updated'; participantId: string; status: ConnectionStatus }
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
 * - `runner`  — spawn a headless run per mention. Claude Code and Codex.
 * - `remote`  — plain MCP client, pull-only. Anything that speaks MCP.
 */
export type SetupLane = 'bridge' | 'runner' | 'remote';

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
  /** The requesting user's role and participant identity in this session. */
  me: { role: SessionRole; participantId: string };
  /** The ready-to-paste `claude mcp add` command. See docs/protocol.md. */
  mcpEndpoint: string;
}

/* -------------------------------------------------------------------------- */
/* M1 — auth, membership, invites                                             */
/* -------------------------------------------------------------------------- */

export type SessionRole = 'owner' | 'member';

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
}

export interface SessionSummary {
  publicId: string;
  ownerSlug: string;
  title: string;
  status: SessionStatus;
  role: SessionRole;
  memberCount: number;
  createdAt: string;
}

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
