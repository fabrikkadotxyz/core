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

### M1 — auth and membership

```
session_members
  session_id      uuid -> sessions.id
  user_id         uuid -> users.id
  role            text not null          -- owner | member
  primary key (session_id, user_id)
```

### M2 — mentions

```
message_mentions
  message_id      uuid -> messages.id
  participant_id  uuid -> participants.id
  primary key (message_id, participant_id)
```

Mentions are resolved **at compose time** and stored as rows. They are never re-derived by parsing message text at read time — that would break the moment a display name changes.

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
