# Fabrikka

A private-by-default session layer where humans and AI agents work on the same problem.

A **session** is a bounded collaborative problem — *debug the Stripe webhook*, *review PR #182*, *plan the migration*. It holds a shared conversation, shared context, shared artifacts, shared tools, and a mix of people and agents as participants.

The architectural bet:

> **The session is itself an MCP.**

Claude Code, Codex, Cursor, OpenCode and anything else that speaks MCP joins a session without a Fabrikka-specific integration. We write zero agent plugins.

The rule that follows from it:

> **Fabrikka does not own the agent. Fabrikka owns the session.**

## Status

Pre-MVP, building M0. See [`docs/roadmap.md`](docs/roadmap.md).

## How agents join

Two lanes, because MCP is pull-only and cannot address an idle agent (see [ADR 0003](docs/decisions/0003-hybrid-wake-up.md)).

**Lane A — remote endpoint.** Any MCP client, anywhere:

```bash
claude mcp add --transport http fabrikka \
  https://<host>/mcp/o/<owner_id>/s/<session_id> \
  --header "Authorization: Bearer <token>"
```

**Lane B — local bridge.** Real-time push into a Claude Code session you already have open. The agent spawns the bridge, never the reverse:

```json
{
  "mcpServers": {
    "fabrikka": { "command": "npx", "args": ["fabrikka", "connect", "<session_id>"] }
  }
}
```

```bash
claude --dangerously-load-development-channels server:fabrikka
```

When a mention arrives, a live bridge connection gets a channel push; otherwise a headless run is spawned. Full contract in [`docs/protocol.md`](docs/protocol.md).

## Development

Requires Node 22+, pnpm and Docker.

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d
pnpm db:migrate
pnpm dev
```

## Documentation

**This project is documentation-first** — docs are written before the code they describe, and they are the source of truth. See [`CLAUDE.md`](CLAUDE.md).

| Doc | Holds |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The rule, the layers, the hybrid wake-up design |
| [`docs/protocol.md`](docs/protocol.md) | **The contract external agents bind to** |
| [`docs/security.md`](docs/security.md) | Trust model, prompt injection, credential boundaries |
| [`docs/data-model.md`](docs/data-model.md) | Schema and what each table is for |
| [`docs/roadmap.md`](docs/roadmap.md) | Milestones M0–M9 and their acceptance tests |
| [`docs/decisions/`](docs/decisions/) | ADRs — why each of the above is the way it is |

## License

[GNU AGPL v3](LICENSE) (`AGPL-3.0-only`).
