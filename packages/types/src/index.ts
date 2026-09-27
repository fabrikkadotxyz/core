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

export interface SessionView {
  session: Session;
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
