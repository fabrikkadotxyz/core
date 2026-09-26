/**
 * Database schema. Documented in docs/data-model.md — update that first.
 *
 * Tables are introduced by the milestone that needs them (docs/roadmap.md).
 * This file currently covers M0: the messaging core.
 */
import {
  index,
  jsonb,
  pgTable,
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
  /** Null until M1 introduces auth. */
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
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
