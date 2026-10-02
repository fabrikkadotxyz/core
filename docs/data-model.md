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
  participant_id  uuid -> participants.id not null unique
  session_id      uuid -> sessions.id not null
  kind            text not null          -- bridge | runner | remote_http
  status          text not null          -- connected | working | idle | offline
  last_seen_at    timestamptz not null
```

Keyed on **participant**, not agent: an agent is only "present" as a participant
of a specific session, and that is also what a token identifies (ADR 0009). One
row per participant, upserted — a reconnect replaces the previous state rather
than accumulating rows.

`kind` decides delivery. Only a `bridge` can receive a `claude/channel` push; a
`runner` spawns a headless run instead. When both exist the `bridge` wins, because
pushing into a session that already holds the user's context beats starting a fresh
one. See `ARCHITECTURE.md` and [ADR 0011](decisions/0011-spawning-is-local-and-opt-in.md).

### M6 — safety rails

```
sessions  (additions)
  agents_paused_at     timestamptz   -- null = agents active
  agents_paused_reason text          -- manual | turn_budget

session_turn_budget
  session_id       uuid -> sessions.id pk
  window_start     timestamptz not null
  agent_turns_used int not null default 0
```

One paused state, two causes — a human hitting the switch, or the budget running
out. One mechanism means one thing to test and one way to resume, and no way to be
manually paused and budget-paused at once with unclear precedence.

A *turn* is one **delivery** to one agent: a channel push or a spawn. Deliveries
are counted rather than messages or tokens because a delivery is precisely the
thing that makes an agent act, it is the chokepoint every path already funnels
through, and token usage is not ours to see — the agent runs under the user's own
credentials, by design.

The window lives in Postgres rather than memory so it survives a restart and works
with more than one server process. See
[ADR 0012](decisions/0012-halt-is-server-side-termination-is-cooperative.md).

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
  version         int not null default 0  -- increments on every write
  updated_at      timestamptz

artifacts
  id              uuid pk
  session_id      uuid -> sessions.id not null
  type            text not null          -- file | link
  name            text not null          -- display name; collisions are fine
  storage_key     text not null          -- sha256 of content, or the URL for a link
  content_type    text
  size_bytes      int
  created_by_participant_id uuid -> participants.id not null
  created_at      timestamptz not null
  index (session_id)
```

**`version` exists so a wholesale replace can be rejected.** Lists are
append-first (`add_facts` / `remove_facts`), and the replace form requires the
version the caller last read — otherwise an agent writing back "the complete list"
silently deletes what a human typed a minute earlier. See
[ADR 0013](decisions/0013-context-is-append-only-with-explicit-removal.md).

**`storage_key` is the SHA-256 of the file's content**, not its name. Two people
uploading `notes.md` get two artifact rows sharing one blob, and neither
overwrites the other. The display name lives on the row, so collisions are a
non-event rather than data loss.

Context is **not** over-normalized. Facts and decisions are lists of text with timestamps, not an entity graph. If this needs to become relational later, that will be obvious from use — it is not obvious now.

### M10 — runs and activity

```
runs
  id               uuid pk
  session_id       uuid -> sessions.id not null
  participant_id   uuid -> participants.id not null   -- the agent
  trigger_message_id uuid -> messages.id              -- the mention that started it
  kind             text not null          -- channel | spawn
  provider         text
  resume_handle    text                   -- --resume / thread id, when supported
  status           text not null          -- running | done | stopped | failed
  started_at       timestamptz not null
  ended_at         timestamptz
  index (session_id, started_at)

session_agents  (addition)
  activity_visible boolean not null default true
```

`resume_handle` exists but is **not written yet** — M15 (steering) fills it, because a
correction can only continue a run that remembered how to be continued. The column
is here rather than in a later migration so `runs` has one shape.

**M16 adds (specced, not built):**

```
session_agents  (addition)
  model            text                   -- null = the agent's own default

runs  (additions)
  model_requested  text                   -- what we asked for, if anything
  model_used       text                   -- what the stream reported
```

`model_requested` and `model_used` are separate because `--fallback-model` exists:
"asked for opus, ran on sonnet" is a different fact from either one alone, and
collapsing them hides the interesting half. `model` only affects **spawned** runs —
on a live session the model was chosen before we were involved. See
[ADR 0017](decisions/0017-model-selection-is-spawn-only.md).

**There is no `activity` table, deliberately.** Activity events live in a capped
in-memory buffer per run and are discarded when it ends: hundreds of rows per run
for something nobody re-reads later. The run's *outcome* is a durable message; the
steps that produced it are not. See
[ADR 0015](decisions/0015-activity-is-a-redacted-summary.md).

`runs` exists so activity can group **and** so a correction can name the run it is
correcting rather than racing it
([ADR 0016](decisions/0016-steering-is-stop-and-resume.md)).

### M8 — MCP aggregation

```
mcp_servers                               -- a user's own external connection
  id              uuid pk
  owner_id        uuid -> users.id not null
  slug            text not null           -- the integration: "github", "sentry"
  label           text not null
  url             text not null           -- streamable HTTP only
  sealed_credential text                  -- AES-256-GCM; never returned by any API
  created_at      timestamptz not null
  unique (owner_id, slug)

session_mcp_servers
  session_id       uuid -> sessions.id
  mcp_server_id    uuid -> mcp_servers.id
  added_by_user_id uuid -> users.id not null
  primary key (session_id, mcp_server_id)

session_mcp_tool_grants
  session_id      uuid -> sessions.id
  server_slug     text not null           -- the integration, NOT a specific row
  tool_name       text not null
  allowed         boolean not null default false
  primary key (session_id, server_slug, tool_name)
```

**There is no `transport` column: HTTP only.** A command-launched stdio server
would mean this server executing arbitrary commands from a database row. Local
servers belong to the bridge, on the user's own machine. See
[ADR 0014](decisions/0014-aggregation-is-http-only-and-credentials-are-encrypted.md).

**`sealed_credential` is encrypted, not hashed.** Unlike a session token, an
upstream credential has to be recoverable because the server presents it. Sealed
with AES-256-GCM under `FABRIKKA_ENCRYPTION_KEY`; without that key configured,
attaching a credentialed server **fails** rather than storing plaintext.

**Grants are keyed by `server_slug`, not `mcp_server_id`** — a correction to the
shape sketched at M0. Fede and Alice each attach their own GitHub with their own
token: two rows, one integration. What the *session* permits is a property of the
session, not of whose token is behind it. Keying by row would mean re-granting per
member, and a session where Alice can merge because nobody denied it on her row.

Credentials belong to a **user**, not a session. A tool call routes to the *calling participant's* credential; a server a participant hasn't attached is absent from their tool list entirely. Grants are **tool-level and default-deny** — server-level granularity cannot express "GitHub read but not merge", which is the actual requirement. See `docs/security.md`.

### M12 — outputs (M14's `google_accounts` specced, not built)

```
outputs
  id              uuid pk
  session_id      uuid -> sessions.id not null
  kind            text not null           -- doc | latex | gdoc
  name            text not null           -- display name; collisions are fine
  main_file       text not null           -- "document.md", "main.tex"
  state           bytea                   -- doc, latex: encoded Yjs document (all files)
  external_ref    text                    -- gdoc: the Google file id
  version         int not null default 0  -- increments on every applied edit
  build           jsonb                   -- latex: latest build report from a viewer
  created_by_participant_id uuid -> participants.id not null
  created_at      timestamptz not null
  updated_at      timestamptz not null
  index (session_id)

output_edits                              -- the changes log; append-only
  id              uuid pk
  output_id       uuid -> outputs.id not null
  file            text not null
  participant_id  uuid -> participants.id -- null for a Google edit by someone not in the session
  run_id          uuid -> runs.id         -- set when an agent edited inside a run
  external_author text                    -- gdoc: the Google account Drive reported
  version         int not null            -- the output's version after this edit
  added_lines     int not null
  removed_lines   int not null
  diff            text not null           -- unified diff of the file, before → after
  created_at      timestamptz not null
  index (output_id, created_at)

google_accounts                           -- M14, not built; a user's own connection
  user_id         uuid -> users.id pk
  google_email    text not null
  sealed_refresh_token text not null      -- AES-256-GCM; never returned by any API
  created_at      timestamptz not null
```

**One `state` blob per output, not a row per file.** A `latex` output's files are
`Y.Text`s inside one Yjs document, so a single edit spanning `main.tex` and
`refs.bib` is one transaction. Splitting files into rows would split that.

**`state` is the source of truth for native kinds; `version` is a counter beside
it**, bumped on every applied edit so `if_version` has something to compare. It is
not a Yjs concept, and a human's keystrokes bump it too — which is why agents edit
by anchor rather than by version
([ADR 0019](decisions/0019-outputs-are-live-documents-behind-adapters.md)).

**`output_edits.diff` is stored, not recomputed.** For native kinds the history
needed to recompute it is in the Yjs document only until it is garbage-collected;
for `gdoc` it is in Google's history, which may later be unreachable. "What did
claude-alice change at 14:02" has to be answerable afterwards. Human typing is
coalesced per participant into one row after ten seconds idle, so this table grows
with *edits*, not keystrokes.

**`google_accounts` belongs to a user, not a session**, for the same reason as
`mcp_servers`: a credential is a person's. See
[ADR 0021](decisions/0021-google-docs-writes-use-the-editors-own-account.md).
