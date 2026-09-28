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
  | { type: 'hello'; sessionId: string; participants: Participant[] }
  | { type: 'message.created'; message: Message }
  | { type: 'participant.updated'; participant: Participant }
  | { type: 'context.updated'; context: SessionContext }
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
  updatedAt: string | null;
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
