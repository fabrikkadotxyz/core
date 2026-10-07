# Fabrikka

A private-by-default session layer where humans and AI agents work on the same problem.

A **session** is a bounded collaborative problem — *debug the Stripe webhook*, *review PR #182*, *plan the migration*. It holds a shared conversation, shared context, shared artifacts, shared tools, and a mix of people and agents as participants.

The architectural bet:

> **The session is itself an MCP.**

Claude Code, Codex, Cursor, OpenCode and anything else that speaks MCP joins a session without a Fabrikka-specific integration. We write zero agent plugins.

The rule that follows from it:

> **Fabrikka does not own the agent. Fabrikka owns the session.**

## Status

Pre-MVP. **M0–M13 built**: auth and private sessions, participants and mentions,
the remote session MCP endpoint, the bridge channel, spawn-on-mention with Claude
Code and Codex, safety rails, session context and artifacts, per-participant MCP
aggregation, a Tauri shell, live activity, the three-pane session screen, live shared documents, and LaTeX papers compiled in
the browser. Output kinds are plug-in modules (ADR 0023). Built ahead of order
because they need no outside accounts: **M19** session links and **M20** agents
reading uploaded PDFs (their stories wait on M18's connections), **M21** teams and
**M22** team-visible sessions and guests, **M23** comments on outputs, and **M24**
catch-up and handoffs (its stories' vendor half waits on M18), **M25** session
templates, **M27** export, **M28** a Slack-like home with a team switcher, and
**M29** team chats and direct chats, **M30** team integrations (credentials a team
shares), **M31** the local host (your agents in folders you grant, safely), and
**M32** the server as a library, with password reset by email when an email
transport is configured. M14 (Google Docs) and M18 (connections) wait on real
vendor accounts — see [`docs/roadmap.md`](docs/roadmap.md).

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
    "fabrikka": {
      "command": "fabrikka",
      "args": ["connect"],
      "env": { "FABRIKKA_URL": "<session endpoint>", "FABRIKKA_TOKEN": "<token>" }
    }
  }
}
```

```bash
claude --dangerously-load-development-channels server:fabrikka
```

When a mention arrives, a live bridge connection gets a channel push; otherwise a headless run is spawned. Full contract in [`docs/protocol.md`](docs/protocol.md).

**Your computer, once.** Every instance serves its own client (Node 22+). Copy
the command from *Your devices*:

```bash
curl -fsSL https://<your instance>/install.sh | bash
```

It installs `fabrikka` into your home folder, then opens the pairing page. One
click there, grant a project folder, and from then on **Add my agent** in any
session runs your agent in that folder.

## Development

Requires Node 22+, pnpm and Docker. **No mail server** — see
[ADR 0007](docs/decisions/0007-email-is-a-transport.md).

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate

# Create the first account. There is no open registration, so this is the
# only way in on a fresh instance.
pnpm admin create-user --email you@example.com --owner

pnpm dev          # web on :5173, server on :9090
```

Then invite people with a **link**, not an email: open a session, *Create invite
link*, and send it however you like. Forgot a password?
`pnpm admin reset-password --email <e>`. See [`docs/operations.md`](docs/operations.md).

## Documentation

**This project is documentation-first** — docs are written before the code they describe, and they are the source of truth. See [`CLAUDE.md`](CLAUDE.md).

| Doc | Holds |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The rule, the layers, the hybrid wake-up design |
| [`docs/protocol.md`](docs/protocol.md) | **The contract external agents bind to** |
| [`docs/security.md`](docs/security.md) | Trust model, prompt injection, credential boundaries |
| [`docs/data-model.md`](docs/data-model.md) | Schema and what each table is for |
| [`docs/operations.md`](docs/operations.md) | Running an instance: bootstrap, admin CLI, invites, backups |
| [`docs/roadmap.md`](docs/roadmap.md) | Milestones M0–M35 and their acceptance tests |
| [`docs/decisions/`](docs/decisions/) | ADRs — why each of the above is the way it is |

## License

[GNU AGPL v3](LICENSE) (`AGPL-3.0-only`).
