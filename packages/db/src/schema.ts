/**
 * Database schema. Documented in docs/data-model.md — update that first.
 *
 * Tables are introduced by the milestone that needs them (docs/roadmap.md).
 * Currently covers M0 (messaging core), M1 (auth, membership, invites) and
 * M2 (mentions).
 */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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
   * Always null self-hosted: email is an identifier, not a proven address
   * (ADR 0007). Recorded so cloud verification can layer on without a schema
   * change; nothing in the core reads it.
   */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Public id. Appears in the MCP endpoint path. Never sessions.id. */
  publicId: text('public_id').notNull().unique(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** active | archived */
  status: text('status').notNull().default('active'),
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
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
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
  (t) => [index('session_invites_session_idx').on(t.sessionId)],
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
