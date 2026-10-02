# Architecture

## The rule

> **Fabrikka does not own the agent. Fabrikka owns the session.**

Agents may be Claude Code, Codex, Cursor, OpenCode, or something that doesn't exist yet. Fabrikka does not need to know how they reason or which model they use. It needs to know:

- Who is participating?
- What session are they in?
- What can they access?
- What has happened?
- What tools are available?
- What context is relevant?
- Who is being addressed?

That boundary is the product. Everything below serves it.

```
                 ┌───────────────────────────┐
                 │        FABRIKKA          │
Human ──────────►│                           │
Human ──────────►│         SESSION           │
Claude ─────────►│                           │
Codex  ─────────►│  Context                  │
Cursor ─────────►│  Messages                 │
                 │  Participants             │
                 │  Permissions              │
                 │  MCP routing              │
                 └─────────────┬─────────────┘
                     ┌─────────┼─────────┐
                     ↓         ↓         ↓
                  GitHub     Sentry     Slack
```

## Core abstraction: the Session

A session is a bounded collaborative problem. It is private by default, persistent, independently permissioned, and independently connected to MCP servers. It is the first-class object — there is no Organization → Workspace → Channel → Thread hierarchy.

```
Account
└── Session
    ├── Participants (humans and agents, one id space)
    ├── Messages + Mentions
    ├── Context (objective, facts, decisions, questions)
    ├── Artifacts
    ├── Attached MCP servers
    └── Permissions
```

### Participants, not "user and assistant"

Humans and agents are the same kind of thing: a `participant` in a session. `@fede` and `@claude-fede` differ by `kind`, not by which part of the UI they live in. This is what makes `@claude-fede` and `@claude-alice` — both Claude Code, different identities — fall out for free.

`Claude Code` is a *provider*. `@claude-fede` is a *participant*.

## The problem that shapes everything: MCP is pull-only

The obvious design is "the session is an MCP endpoint, agents connect to it." That works for an agent *reading and writing* a session. It does not work for *addressing* one.

**An MCP server cannot make an idle agent act.** `sampling` — the one server→client primitive that could have asked a client's model to think — was deprecated in the 2026-07-28 spec alongside Roots and Logging. Server-initiated events are Priority 1 on the roadmap but have not shipped. Today the only universally-available pattern is the client polling.

So `@claude-fede investigate this` has no standard delivery mechanism. Two things fill the gap.

### Lane A — remote HTTP endpoint (universal, pull)

```
https://app.fabrikka.dev/mcp/o/{owner_id}/s/{session_id}
```

`owner_id` is the owner's public slug and is validated against the session on every request — a mismatch is a 404, never a 403. It is a routing and legibility aid, never an authorization input. See `docs/protocol.md`.

Any MCP client can connect. The agent reads session context, reads messages, posts messages, and calls aggregated tools. It participates whenever it happens to be running. It is never interrupted, because it cannot be.

This is the positioning claim — *the session is itself an MCP* — and it holds. It just isn't sufficient on its own.

### Lane B — local bridge (real-time, Claude Code)

Claude Code supports a proprietary `claude/channel` capability: an MCP server can push `notifications/claude/channel` into a **live** session, and Claude reacts on its next turn, replying through a normal tool. Constraints: **stdio only**, research preview, needs `--dangerously-load-development-channels` for third-party channels, needs first-party Anthropic auth.

Stdio-only means it must run locally. Hence the bridge:

```
Claude Code ──stdio──> fabrikka bridge ──WebSocket──> Fabrikka server
                        ├─ claude/channel push   (session → agent)
                        ├─ reply tool            (agent → session)
                        └─ session tools
```

**The bridge is spawned by the agent.** Claude Code reads `.mcp.json`, starts `fabrikka connect` as a subprocess, and talks to it over stdin/stdout. The bridge does not start, install, supervise or configure Claude Code. This is the rule at the top of this document, made concrete.

## Hybrid wake-up

The two lanes compose into one delivery decision:

```
@mention arrives in session
  │
  ├─ live bridge connection attached?  ──yes──>  claude/channel push
  │                                              agent's own session, repo open,
  │                                              context loaded, permissions intact
  │
  └─ no ──────────────────────────────────────>  spawn headless run per mention
                                                 claude -p …   /   codex exec …
                                                 async delegation, human away
```

The channel path is *collaboration* — a human is present and the agent already has the problem loaded. The spawn path is *delegation* — nobody is at the terminal, so a fresh agent is started, given the session over MCP, and its output posted back.

Codex has no channel equivalent, so it always takes the spawn path. See `docs/protocol.md` for exact invocations.

### Why not own the runtime

A runtime-owning approach solves the same problem with a daemon that installs and supervises agent CLIs: it polls its own API and spawns agents. It works, and it gives clean multi-vendor parity.

We don't do that, because the moment Fabrikka installs and supervises agent runtimes it inherits every agent's install, update, auth and breakage surface — and it stops being a session layer. Our spawn path shells out to a binary the user already has and already authenticated. It never manages one.

## Layers

| Layer | What it is | Where |
| --- | --- | --- |
| Session layer | Events, participants, messages, context, artifacts, outputs, permissions | `apps/server` |
| Interaction layer | Web UI; later, desktop | `apps/web`, `apps/desktop` |
| Connection layer | Remote MCP endpoint (lane A) + bridge CLI (lane B) | `apps/server/src/mcp`, `packages/bridge` |

Agent runtimes are deliberately **not** a layer we own.

## Realtime

Independent transports, which should not be conflated:

- **Browser ↔ server:** WebSocket, carrying the session event stream for the UI.
- **Bridge ↔ server:** WebSocket, carrying mention delivery and agent presence.
- **Browser ↔ server, per open output** *(M12)*: WebSocket speaking the Yjs sync
  protocol, so humans co-edit a document in real time. Agents do not use it; their
  edits arrive over MCP and are applied server-side as one more editor (ADR 0019).

MCP connections are separate from all of them. An agent on lane A has no realtime connection at all.

## What we are deliberately not building

No built-in LLM provider. No Fabrikka-hosted Claude or Codex. No autonomous orchestration, agent marketplace (the output catalogue of ADR 0019 lists built-in document kinds; it does not load anyone else's code), workflows, RAG, vector database, public sessions, organizations, billing, mobile, SSO, or elaborate RBAC.

The MVP answers one question: *does it feel useful to have a private room where I work with my existing agents and other people?*

## Further reading

- `docs/protocol.md` — the contract agents bind to
- `docs/security.md` — trust model and its limits
- `docs/decisions/` — why each of the above is the way it is
