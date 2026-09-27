# Data model

PostgreSQL via Drizzle (pinned 0.45.x — Drizzle 1.0 is still RC). Tables are introduced by the milestone that needs them; see `docs/roadmap.md`.

## Identifiers

Two id spaces, deliberately separate:

- **Internal ids** — database primary keys. Never leave the server.
- **Public ids** — opaque, stable, safe to put in URLs, `.mcp.json` files, logs and committed repos.

`users.owner_slug` and `sessions.public_id` are public ids. They appear in the MCP endpoint path (`/mcp/o/{owner_id}/s/{session_id}`) and must never be the internal primary key. See `docs/protocol.md`.

## Tables

### M0 — messaging core

```
users
  id              uuid pk
  owner_slug      text unique not null   -- public id; appears in MCP URLs
  email           text unique not null
  password_hash   text                   -- null until M1
  display_name    text not null
  created_at      timestamptz not null

sessions
  id              uuid pk
  public_id       text unique not null   -- public id; appears in MCP URLs
  owner_id        uuid -> users.id not null
  title           text not null
  status          text not null          -- active | archived
  created_at      timestamptz not null

participants                              -- one id space for humans AND agents
  id              uuid pk
  session_id      uuid -> sessions.id not null
  kind            text not null          -- human | agent
  user_id         uuid -> users.id       -- set when kind = human
  session_agent_id uuid -> session_agents.id  -- set when kind = agent
  display_name    text not null
  unique (session_id, display_name)

messages
  id              uuid pk
  session_id      uuid -> sessions.id not null
  author_participant_id uuid -> participants.id not null
  content         text not null
  metadata        jsonb
  created_at      timestamptz not null
  index (session_id, created_at)
```

**Why `participants` exists.** Author and mention never branch on human-vs-agent. `@fede` and `@claude-fede` are the same kind of row, differing by `kind`. This is what makes `@claude-fede` and `@claude-alice` — both Claude Code, different identities — fall out for free, and it means renaming a display name doesn't orphan historical messages.

### M1 — auth, membership, invites

No outbound email is required for any of this — see
[ADR 0007](decisions/0007-email-is-a-transport.md).

```
users  (additions)
  is_instance_owner boolean not null default false
    -- Created by `admin create-user --owner`. Distinct from a session's owner
    -- role: this is instance-level, that is per-session.
  email_verified_at timestamptz
    -- Always null self-hosted. Recorded so cloud verification can layer on
    -- without a schema change; nothing in the core reads it.

auth_sessions                             -- login sessions, server-side
  id              uuid pk
  user_id         uuid -> users.id not null
  token_hash      text not null unique    -- SHA-256 of the cookie value
  expires_at      timestamptz not null
  created_at      timestamptz not null
  last_seen_at    timestamptz not null
  index (user_id)

session_members
  session_id      uuid -> sessions.id
  user_id         uuid -> users.id
  role            text not null          -- owner | member
  primary key (session_id, user_id)

session_invites
  id              uuid pk
  session_id      uuid -> sessions.id not null
  token_hash      text not null unique    -- SHA-256; the plaintext is shown ONCE
  role            text not null default 'member'
  invited_email   text                    -- optional scope; see below
  created_by_user_id uuid -> users.id not null
  expires_at      timestamptz not null
  redeemed_at     timestamptz
  redeemed_by_user_id uuid -> users.id
  revoked_at      timestamptz
  index (session_id)
```

**Login sessions are server-side rows, not JWTs.** A stateless token cannot be
revoked before it expires. Membership here governs access to private sessions
that hold credentials, so revocation has to be immediate — logging out, removing
a member, or resetting a password must invalidate access now, not in an hour.
The cookie carries an opaque random value; only its SHA-256 is stored, so a
database read does not yield usable credentials.

**Invite tokens are stored hashed, for the same reason.** The plaintext is
returned exactly once, at creation, and is never recoverable afterwards. If it
is lost, revoke and reissue.

**`invited_email` scopes an invite without sending anything.** When set, only a
user authenticating as that address may redeem it. This is the security property
of an addressed invite with zero mail configuration — enforcement happens at
redemption, not delivery.

**There is no open registration.** The first account comes from
`admin create-user --owner`; every subsequent account is created by redeeming an
invite. Signup and invite-acceptance are therefore one code path, not two.

### M2 — mentions

```
message_mentions
  message_id      uuid -> messages.id
  participant_id  uuid -> participants.id
  primary key (message_id, participant_id)
```

`messages.content` stores **stable markers** — `<@participant_id>` — not display
names, and these rows are **derived from those markers at write time**. See
[ADR 0008](decisions/0008-mentions-as-stable-markers.md).

```
stored content:  "I think <@a1b2c3> should look at the webhook handler"
derived rows:    message_mentions(message_id, a1b2c3)
```

Two properties follow, and both matter:

- **A rename is correct retroactively.** Display names resolve at read time, so
  renaming a participant fixes every message that ever mentioned them, with no
  backfill.
- **Content and mention rows cannot disagree**, because the rows are computed
  from the content rather than supplied next to it. A message whose text says
  `@alice` while its rows point at Bob is not a representable state.

Mentions are never re-derived by parsing display names at read time — that breaks
the moment a name changes, and it is what the product spec explicitly rules out.

A mention must reference a participant **of the same session**. A foreign id is
rejected at write time, not dropped; see `docs/security.md`.

### M3–M5 — agents and connections

```
agents
  id              uuid pk
  owner_id        uuid -> users.id not null
  provider        text not null          -- claude-code | codex | other
  name            text not null

session_agents
  id              uuid pk
  session_id      uuid -> sessions.id not null
  agent_id        uuid -> agents.id not null
  display_name    text not null
  trust_tier      text not null default 'owner_only'   -- owner_only | session_trusted

agent_connections
  id              uuid pk
  agent_id        uuid -> agents.id not null
  session_id      uuid -> sessions.id not null
  kind            text not null          -- bridge | remote_http
  status          text not null          -- connected | working | idle | offline
  last_seen_at    timestamptz not null
```

`kind` matters: only a `bridge` connection can receive a `claude/channel` push. A mention to an agent with no live `bridge` connection takes the spawn path instead. See `ARCHITECTURE.md`.

### M6 — safety rails

```
session_turn_budget
  session_id      uuid -> sessions.id pk
  window_start    timestamptz not null
  agent_turns_used int not null default 0
```

`trust_tier` on `session_agents` (above) defaults to `owner_only`: only the agent's own owner can cause it to act. Elevation is a deliberate per-session act by the owner. See `docs/security.md`.

### M7 — context and artifacts

```
session_context                           -- deliberately denormalized
  session_id      uuid -> sessions.id pk
  objective       text
  facts           jsonb
  decisions       jsonb
  questions       jsonb
  constraints     jsonb
  updated_at      timestamptz

artifacts
  id              uuid pk
  session_id      uuid -> sessions.id not null
  type            text not null          -- file | link | document
  storage_key     text not null
  created_by_participant_id uuid -> participants.id not null
  created_at      timestamptz not null
```

Context is **not** over-normalized. Facts and decisions are lists of text with timestamps, not an entity graph. If this needs to become relational later, that will be obvious from use — it is not obvious now.

### M8 — MCP aggregation

```
mcp_servers                               -- a user's own external connection
  id              uuid pk
  owner_id        uuid -> users.id not null
  name            text not null
  transport       text not null          -- http | stdio
  configuration   jsonb not null         -- credentials encrypted at rest

session_mcp_servers
  session_id      uuid -> sessions.id
  mcp_server_id   uuid -> mcp_servers.id
  added_by_user_id uuid -> users.id not null
  primary key (session_id, mcp_server_id)

session_mcp_tool_grants
  session_id      uuid -> sessions.id
  mcp_server_id   uuid -> mcp_servers.id
  tool_name       text not null
  allowed         boolean not null default false
  primary key (session_id, mcp_server_id, tool_name)
```

Credentials belong to a **user**, not a session. A tool call routes to the *calling participant's* credential; a server a participant hasn't attached is absent from their tool list entirely. Grants are **tool-level and default-deny** — server-level granularity cannot express "GitHub read but not merge", which is the actual requirement. See `docs/security.md`.
