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

/**
 * How much authority a message's author has over a receiving agent.
 *
 * Evaluated per recipient: the same message is `owner` to the agent its author
 * owns and `untrusted` to every other agent in the session. Anything below
 * `owner` is data, never instructions. See docs/security.md.
 */
export type TrustTier = 'owner' | 'session' | 'untrusted';

/** Default is `owner_only` — only an agent's own owner can cause it to act. */
export type AgentTrustPolicy = 'owner_only' | 'session_trusted';

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

export interface Message {
  id: string;
  sessionId: string;
  author: {
    participantId: string;
    kind: ParticipantKind;
    displayName: string;
  };
  content: string;
  /** Participant ids, resolved at compose time — never re-parsed from content. */
  mentions: string[];
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

/** Server -> client. */
export type ServerEvent =
  | { type: 'hello'; sessionId: string; participants: Participant[] }
  | { type: 'message.created'; message: Message }
  | { type: 'participant.updated'; participant: Participant };

/** Client -> server. M0 posts over HTTP; the socket is read-only for now. */
export type ClientEvent = { type: 'ping' };

/* -------------------------------------------------------------------------- */
/* HTTP API                                                                   */
/* -------------------------------------------------------------------------- */

export interface PostMessageBody {
  /** Composer-resolved participant ids. */
  mentions?: string[];
  content: string;
}

export interface SessionView {
  session: Session;
  participants: Participant[];
  /** The ready-to-paste `claude mcp add` command. See docs/protocol.md. */
  mcpEndpoint: string;
}
