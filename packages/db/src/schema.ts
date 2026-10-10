/**
 * Database schema. Documented in docs/data-model.md — update that first.
 *
 * Tables are introduced by the milestone that needs them (docs/roadmap.md).
 * Currently covers M0 (messaging core), M1 (auth, membership, invites),
 * M2 (mentions), M3 (agents, tokens, session context), M4 (presence),
 * M6 (safety rails), M7 (artifacts), M8 (MCP aggregation), M10 (runs) and
 * M12 (outputs), M19 (links), M21 (teams), M22 (guests), M23 (comments) and
 * M24 (catch-up), M25 (templates), M27 (context history), M29 (chats) and
 * M31 (devices).
 */
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/* M0 — messaging core                                                        */
/* -------------------------------------------------------------------------- */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Public id. Appears in the MCP endpoint path (/mcp/o/{owner_id}/...), so it
   * lands in .mcp.json files, shell history and CI logs. Never users.id.
   * See docs/decisions/0006-owner-scoped-endpoint-path.md.
   */
  ownerSlug: text('owner_slug').notNull().unique(),
  email: text('email').notNull().unique(),
  /** scrypt$N$r$p$salt$hash — see docs/security.md. */
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
  /** Set by `admin create-user --owner`. Instance-level, not per-session. */
  isInstanceOwner: boolean('is_instance_owner').notNull().default(false),
  /**
   * Null unless a deployment verified the address before creating the account
   * (ADR 0007, 0029): a deployment's sign-up sets it through the kit. Email is an
   * identifier, not a proven address, and nothing in the core reads it.
   */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /**
   * The look this person chose (M44, ADR 0038): a theme id, 'system', or null
   * for the default. Not a foreign key: themes are folders, not rows.
   */
  theme: text('theme'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A team: a list of people who trust each other, and nothing else. See ADR 0025.
 * No SSO or permission matrix — owners invite and remove, that is all.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * M43: how long team_mcp_calls rows are kept. A fixed list, so the privacy
     * policy can name every possible answer.
     */
    callRecordDays: integer('call_record_days').notNull().default(90),
  },
  (t) => [check('teams_call_record_days', sql`${t.callRecordDays} in (30, 60, 90, 180, 365)`)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** owner | member */
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Public id. Appears in the MCP endpoint path. Never sessions.id. */
  publicId: text('public_id').notNull().unique(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Optional (M21). Decides who can be added from the roster — not who can see. */
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  /** private | team (M22). `team` makes every teammate a viewer; needs a team. */
  visibility: text('visibility').notNull().default('private'),
  /** The template it started from (M25): "builtin:<id>" or a session_templates id. */
  templateRef: text('template_ref'),
  /** session | chat | direct (M29, ADR 0026). A chat is a light session. */
  kind: text('kind').notNull().default('session'),
  /** Direct chats: the two user ids, sorted and joined — one chat per pair. */
  directKey: text('direct_key').unique(),
  /** active | archived */
  status: text('status').notNull().default('active'),
  /**
   * Null means agents are active. Set by a human hitting the kill switch or by
   * the turn budget running out — one state, two causes, so there is one way to
   * resume. See docs/decisions/0012-halt-is-server-side-termination-is-cooperative.md.
   */
  agentsPausedAt: timestamp('agents_paused_at', { withTimezone: true }),
  /** manual | turn_budget */
  agentsPausedReason: text('agents_paused_reason'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One id space for humans AND agents, so author and mention never branch on
 * kind. This is what makes @claude-fede and @claude-alice — both Claude Code,
 * different identities — fall out for free, and it means renaming a display
 * name doesn't orphan historical messages.
 */
export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** human | agent */
    kind: text('kind').notNull(),
    /** Set when kind = 'human'. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Set when kind = 'agent'. The FK to session_agents arrives at M3, when
     * that table does; kept as a bare column now so the shape is stable.
     */
    sessionAgentId: uuid('session_agent_id'),
    displayName: text('display_name').notNull(),
  },
  (t) => [unique('participants_session_display_name').on(t.sessionId, t.displayName)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    authorParticipantId: uuid('author_participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('messages_session_created_idx').on(t.sessionId, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* M1 — auth, membership, invites                                             */
/* -------------------------------------------------------------------------- */

/**
 * Login sessions as server-side rows, NOT JWTs.
 *
 * A stateless token cannot be revoked before it expires, and membership here
 * governs private sessions holding live credentials — logout, member removal and
 * password reset must cut access immediately. Only the SHA-256 of the cookie
 * value is stored, so reading this table yields nothing usable.
 */
/**
 * One emailed password-reset link (M32, ADR 0029). Only the SHA-256 of the
 * link's token is stored; single use, one hour. Rows exist only on an instance
 * with an email transport — without one, recovery is `admin reset-password`.
 */
export const passwordResets = pgTable('password_resets', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

export const sessionMembers = pgTable(
  'session_members',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** owner | member */
    role: text('role').notNull().default('member'),
    /**
     * Set when this access came from the session's team roster (M21). Leaving
     * that team removes exactly these rows; a direct invite clears it.
     */
    viaTeamId: uuid('via_team_id').references(() => teams.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * An invite is a durable record plus a token link — never a message (ADR 0007).
 * Single-use, expiring, revocable, hashed at rest. `invitedEmail` scopes it to
 * one address, enforced at redemption, so it needs no mail server.
 */
export const sessionInvites = pgTable(
  'session_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The session this invite joins — or null for a team invite (M21). */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** The team this invite joins (M21). Exactly one of sessionId, teamId. */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    /** SHA-256. The plaintext is returned exactly once, at creation. */
    tokenHash: text('token_hash').notNull().unique(),
    /** Role granted on redemption. */
    role: text('role').notNull().default('member'),
    /** Optional scope: only a user authenticating as this address may redeem. */
    invitedEmail: text('invited_email'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('session_invites_session_idx').on(t.sessionId),
    check('session_invites_one_target', sql`(${t.sessionId} is null) <> (${t.teamId} is null)`),
  ],
);

/* -------------------------------------------------------------------------- */
/* M2 — mentions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Derived from the `<@participant_id>` markers in messages.content at write
 * time — never supplied alongside it, and never re-parsed from display names at
 * read time. See docs/decisions/0008-mentions-as-stable-markers.md.
 *
 * Because these rows are computed from the content, a message whose text says
 * "@alice" while its rows point at Bob is not a representable state.
 */
export const messageMentions = pgTable(
  'message_mentions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.participantId] }),
    // Delivery (M4-M6) asks "what was this participant mentioned in?", so the
    // participant-first index is the one that matters, not the PK's order.
    index('message_mentions_participant_idx').on(t.participantId),
  ],
);

/* -------------------------------------------------------------------------- */
/* M3 — agents, tokens, session context                                       */
/* -------------------------------------------------------------------------- */

/**
 * An agent belongs to a user, not to a session.
 *
 * `Claude Code` is a provider; `@claude-fede` is a participant. This row is the
 * middle term: a named agent identity owned by someone, which can then be added
 * to any number of sessions. See ARCHITECTURE.md.
 */
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** claude-code | codex | other */
  provider: text('provider').notNull().default('other'),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessionAgents = pgTable(
  'session_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * owner_only (default) | session_trusted
     *
     * Only the agent's own owner can direct it until an owner deliberately
     * elevates the session. Enforcement lands at M6; M3 reports it honestly in
     * each message's `trust` field. See docs/security.md.
     */
    trustTier: text('trust_tier').notNull().default('owner_only'),
    /**
     * Whether this agent's steps are streamed to the session. Streaming your
     * agent's activity to a shared room is a fair default and an unfair
     * obligation — someone working in a private repo gets to decline without
     * leaving the session. See ADR 0015.
     */
    activityVisible: boolean('activity_visible').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('session_agents_session_agent').on(t.sessionId, t.agentId)],
);

/**
 * A bearer token scoped to one (session, participant) pair — an actor, not a
 * user. See docs/decisions/0009-participant-scoped-tokens.md.
 *
 * Separate from `auth_sessions` on purpose: a browser login is a user acting
 * across sessions, an agent token is a participant inside exactly one.
 */
export const sessionTokens = pgTable(
  'session_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The actor this token speaks as. Authorship cannot be spoofed by a body. */
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Human label, e.g. "claude-fede on my laptop". */
    label: text('label'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Nullable: agents are long-lived, so no expiry by default. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('session_tokens_session_idx').on(t.sessionId)],
);

/**
 * Structured session context, deliberately denormalized.
 *
 * Facts and decisions are lists of text, not an entity graph. If this needs to
 * become relational it will be obvious from use; it is not obvious now.
 * See docs/data-model.md.
 */
export const sessionContext = pgTable('session_context', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  objective: text('objective'),
  facts: jsonb('facts').$type<string[]>().notNull().default([]),
  decisions: jsonb('decisions').$type<string[]>().notNull().default([]),
  questions: jsonb('questions').$type<string[]>().notNull().default([]),
  constraints: jsonb('constraints').$type<string[]>().notNull().default([]),
  /**
   * Increments on every write, so a wholesale replace can be rejected when the
   * caller is working from a stale read. Append operations do not need it.
   * See docs/decisions/0013-context-is-append-only-with-explicit-removal.md.
   */
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Files and links attached to a session.
 *
 * `storageKey` is the SHA-256 of the content, not the filename: two participants
 * uploading `notes.md` get two rows sharing one blob, and neither overwrites the
 * other. The display name lives here, so a collision is a non-event.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** file | link */
    type: text('type').notNull(),
    name: text('name').notNull(),
    /** sha256 of the content for a file; the URL for a link. */
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    createdByParticipantId: uuid('created_by_participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('artifacts_session_idx').on(t.sessionId)],
);

/* -------------------------------------------------------------------------- */
/* M4 — agent connections (presence)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A live agent connection.
 *
 * Keyed on participant, not agent: an agent is only "present" as a participant
 * of a specific session, which is also what a token identifies (ADR 0009). One
 * row per participant, upserted, so a reconnect replaces the previous state
 * rather than accumulating rows.
 *
 * `kind` matters for delivery: only a `bridge` connection can receive a
 * claude/channel push. A mention to an agent with no live bridge takes the spawn
 * path at M5. See ARCHITECTURE.md.
 */
export const agentConnections = pgTable(
  'agent_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .unique()
      .references(() => participants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** bridge | remote_http */
    kind: text('kind').notNull(),
    /** connected | working | idle | offline */
    status: text('status').notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('agent_connections_session_idx').on(t.sessionId)],
);

/* -------------------------------------------------------------------------- */
/* M6 — safety rails                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Rolling delivery budget, per session.
 *
 * A "turn" is one delivery to one agent — a channel push or a spawn. Deliveries
 * are counted rather than messages or tokens because a delivery is precisely what
 * makes an agent act, and token usage is not ours to see: the agent runs under
 * the user's own credentials.
 *
 * Per session rather than per agent, because the failure this prevents is a
 * conversation BETWEEN agents. Two agents each under their own cap still loop
 * forever; only a shared budget sees it.
 *
 * In Postgres rather than memory so it survives a restart and works across more
 * than one server process.
 */
export const sessionTurnBudget = pgTable('session_turn_budget', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  windowStart: timestamp('window_start', { withTimezone: true })
    .notNull()
    .defaultNow(),
  agentTurnsUsed: integer('agent_turns_used').notNull().default(0),
});

/* -------------------------------------------------------------------------- */
/* M8 — MCP aggregation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A user's own connection to an external MCP server.
 *
 * HTTP only, deliberately: a command-launched stdio server would make this
 * process an arbitrary-command executor driven by database rows. Local servers
 * belong to the bridge, on the user's machine. See ADR 0014.
 *
 * `sealedCredential` is ENCRYPTED, not hashed — unlike a session token it has to
 * be recoverable, because the server presents it upstream.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The integration: "github", "sentry". Grants key on this, not on the row. */
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    /** AES-256-GCM. Never returned by any read API, never logged. For OAuth, the access token. */
    sealedCredential: text('sealed_credential'),
    /* M18 (ADR 0024): a catalogue connection over OAuth. */
    /** The catalogue entry it came from ("github", "jira"); null for a custom connection. */
    entry: text('entry'),
    /** token | oauth */
    auth: text('auth').notNull().default('token'),
    sealedRefreshToken: text('sealed_refresh_token'),
    /** Null: the vendor's token doesn't expire. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    oauthClientId: uuid('oauth_client_id').references(() => oauthClients.id, { onDelete: 'set null' }),
    tokenEndpoint: text('token_endpoint'),
    /** Per-connection request headers an entry asks for (Grafana's X-Grafana-URL). Never secrets. */
    headers: jsonb('headers').$type<Record<string, string>>(),
    /** ok | needs_reconnect */
    status: text('status').notNull().default('ok'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('mcp_servers_owner_slug').on(t.ownerId, t.slug)],
);

/**
 * What dynamic client registration (RFC 7591) gave this instance, per vendor
 * (M18). Per instance, not per person: the first to connect registers it.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issuer: text('issuer').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    clientId: text('client_id').notNull(),
    sealedClientSecret: text('sealed_client_secret'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('oauth_clients_issuer_redirect').on(t.issuer, t.redirectUri)],
);

/** A sign-in in progress (M18): single use, ten minutes, bound to its person. */
export const oauthFlows = pgTable('oauth_flows', {
  /** SHA-256 of the `state` sent to the vendor. */
  stateHash: text('state_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  entry: text('entry').notNull(),
  /** The PKCE code_verifier, sealed until the exchange. */
  sealedVerifier: text('sealed_verifier').notNull(),
  oauthClientId: uuid('oauth_client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
  tokenEndpoint: text('token_endpoint').notNull(),
  fields: jsonb('fields').$type<Record<string, string>>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const sessionMcpServers = pgTable(
  'session_mcp_servers',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    addedByUserId: uuid('added_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.mcpServerId] })],
);

/**
 * What a session permits, per tool. Absent means DENIED.
 *
 * Keyed by the integration's slug rather than by whose row it is: two members
 * each attach their own GitHub, but what the session allows is a property of the
 * session. Keying by row would mean re-granting per member, and a session where
 * one person can merge because nobody denied it on their row.
 */
export const sessionMcpToolGrants = pgTable(
  'session_mcp_tool_grants',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    serverSlug: text('server_slug').notNull(),
    toolName: text('tool_name').notNull(),
    allowed: boolean('allowed').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.serverSlug, t.toolName] })],
);

/**
 * A connection the TEAM owns (M30, ADR 0028). Added by team owners; used in the
 * team's sessions by its current members and their agents — never attached, and
 * never used where a participant has attached their own for the same slug.
 *
 * Its own table rather than an owner-or-team column on `mcp_servers`, so no query
 * meaning "this person's own credential" can lend someone the team's by accident.
 */
export const teamMcpServers = pgTable(
  'team_mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    /** AES-256-GCM. Never returned by any read API, never logged. */
    sealedCredential: text('sealed_credential'),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('team_mcp_servers_team_slug').on(t.teamId, t.slug)],
);

/**
 * Who used a team credential. The vendor's log names the team's account; this
 * names the participant. No arguments, no results — who acted, not what they sent.
 */
export const teamMcpCalls = pgTable(
  'team_mcp_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamMcpServerId: uuid('team_mcp_server_id')
      .notNull()
      .references(() => teamMcpServers.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    /** The person, or the owner of the agent that called. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agentName: text('agent_name'),
    toolName: text('tool_name').notNull(),
    ok: boolean('ok').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('team_mcp_calls_server_idx').on(t.teamMcpServerId, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* M10 — runs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One unit of agent work, addressable.
 *
 * Exists so activity can group under something, and so a correction can name the
 * run it is correcting rather than racing it (M15, steering). There is deliberately NO
 * `activity` table: events live in a capped in-memory buffer and are discarded
 * when the run ends. Hundreds of rows per run, for something nobody re-reads, is
 * not worth storing — the run's OUTCOME is a durable message. See ADR 0015.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    /** The mention that started it, when there was one. */
    triggerMessageId: uuid('trigger_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    /** channel | spawn */
    kind: text('kind').notNull(),
    provider: text('provider'),
    /** --resume handle or thread id, when the provider supports one. */
    resumeHandle: text('resume_handle'),
    /** running | done | stopped | failed */
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('runs_session_started_idx').on(t.sessionId, t.startedAt)],
);

/* -------------------------------------------------------------------------- */
/* M12 — outputs                                                              */
/* -------------------------------------------------------------------------- */

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * A live document the whole session edits. See ADR 0019.
 *
 * For native kinds `state` is the source of truth: one encoded Yjs document
 * holding every file, so an edit spanning two files is one transaction.
 * `version` is a counter beside it, bumped on every applied edit, so a wholesale
 * replace has something to compare against. It is not a Yjs concept.
 */
export const outputs = pgTable(
  'outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** A registered kind id. See apps/server/src/outputs/registry.ts. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    mainFile: text('main_file').notNull(),
    state: bytea('state'),
    version: integer('version').notNull().default(0),
    /** Owned by the kind, opaque to core (ADR 0023). latex: `{ build }`. */
    kindData: jsonb('kind_data'),
    createdByParticipantId: uuid('created_by_participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outputs_session_idx').on(t.sessionId)],
);

/**
 * The changes log. Append-only.
 *
 * The diff is stored, not recomputed: the history needed to recompute it is
 * garbage-collected out of the Yjs document. Human typing is coalesced, so this
 * grows with edits, not keystrokes.
 */
export const outputEdits = pgTable(
  'output_edits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outputId: uuid('output_id')
      .notNull()
      .references(() => outputs.id, { onDelete: 'cascade' }),
    file: text('file').notNull(),
    participantId: uuid('participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** gdoc: the Google account Drive reported. */
    externalAuthor: text('external_author'),
    version: integer('version').notNull(),
    addedLines: integer('added_lines').notNull(),
    removedLines: integer('removed_lines').notNull(),
    diff: text('diff').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('output_edits_output_created_idx').on(t.outputId, t.createdAt)],
);

/**
 * Pointers to things outside the session: tickets, PRs, repos, docs. See M19.
 *
 * Never a copy — the vendor is the source of truth. `unique (session_id, url)`
 * makes linking an upsert, so reporting a new status is linking again.
 */
export const sessionLinks = pgTable(
  'session_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** issue | pr | repo | page | dashboard | error */
    type: text('type').notNull(),
    /** Free text; defaults to the URL's hostname. */
    provider: text('provider').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    /** As last reported. Fabrikka never polls a vendor. */
    status: text('status'),
    statusAt: timestamp('status_at', { withTimezone: true }),
    addedByParticipantId: uuid('added_by_participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('session_links_session_url').on(t.sessionId, t.url)],
);

/**
 * A viewer of one session from outside its team: a client, an advisor (M22).
 * Not a member and not a participant — read and (M23) comment, nothing else.
 */
export const sessionGuests = pgTable(
  'session_guests',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * Comments on an output, anchored to a quoted passage (M23). Written by people
 * — members, viewers, guests — so keyed by user; agents only resolve, by editing.
 * Whether a thread is outdated is computed from the current text, never stored.
 */
export const outputComments = pgTable(
  'output_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outputId: uuid('output_id')
      .notNull()
      .references(() => outputs.id, { onDelete: 'cascade' }),
    /** A reply's thread. Null for the comment that starts a thread. */
    parentId: uuid('parent_id'),
    file: text('file').notNull(),
    /** The anchored passage. Null on a reply. */
    quote: text('quote'),
    body: text('body').notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** open | resolved — threads only. */
    status: text('status').notNull().default('open'),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedByParticipantId: uuid('resolved_by_participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    resolvedAtVersion: integer('resolved_at_version'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('output_comments_output_created_idx').on(t.outputId, t.createdAt)],
);

/**
 * Where each person left off in a session (M24). Catch-up is the difference
 * between now and this: context lists have no per-item times, so the lists as
 * they were at the last visit are kept beside the timestamp.
 */
export const sessionReads = pgTable(
  'session_reads',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    contextSeen: jsonb('context_seen').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * A session's structure without its content (M25): objective, constraints,
 * starter questions and outputs, recommended connections. Never messages,
 * facts, decisions, members or credentials. Built-in templates are files, not rows.
 */
export const sessionTemplates = pgTable('session_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Shared with a team. Null: just the owner. */
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  body: jsonb('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who changed the session context, and when (M27). Append-only. Context items
 * are plain strings (ADR 0013), so their history lives beside them: one row per
 * item added or removed, one per objective set.
 */
export const contextEvents = pgTable(
  'context_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Null for a template applied when the session was created. */
    participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'set null' }),
    /** objective | facts | decisions | questions | constraints */
    field: text('field').notNull(),
    /** add | remove | set */
    op: text('op').notNull(),
    value: text('value').notNull(),
    /** Insertion order: one write can add several items with the same timestamp. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('context_events_session_created_idx').on(t.sessionId, t.createdAt)],
);

/* ------------------------------------------------------------------------ */
/* M31 — the local host (ADR 0027). The server holds no paths and no policies. */
/* ------------------------------------------------------------------------ */

/** A paired machine running the host. */
export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** SHA-256 of the device token. The plaintext was given to the host once. */
  tokenHash: text('token_hash').notNull().unique(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A pairing waiting for a signed-in person to confirm its code. */
export const devicePairings = pgTable('device_pairings', {
  /** What the host polls with — hashed, like every other secret. */
  deviceCodeHash: text('device_code_hash').primaryKey(),
  /** The short code a person reads off the host and confirms in the browser. */
  userCode: text('user_code').notNull().unique(),
  deviceName: text('device_name').notNull(),
  confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** What a host reports it may use: opaque ids and labels, never paths. */
export const deviceGrants = pgTable(
  'device_grants',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    grantId: text('grant_id').notNull(),
    label: text('label').notNull(),
    /** Agent tools installed on that machine. */
    providers: text('providers').array().notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.grantId] })],
);

/** "This session agent runs on that device, in that grant." */
export const sessionAgentHosts = pgTable('session_agent_hosts', {
  sessionAgentId: uuid('session_agent_id')
    .primaryKey()
    .references(() => sessionAgents.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  grantId: text('grant_id').notNull(),
  /** The token the host holds for it now; re-minted per host connection. */
  tokenId: uuid('token_id').references(() => sessionTokens.id, { onDelete: 'set null' }),
});
