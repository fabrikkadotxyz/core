# 0001 — The session is itself an MCP

**Status:** Accepted
**Date:** 2026-09-25

## Context

For humans and AI agents to work in one room, the agents have to get in. The conventional approach is to build an integration per agent: a Claude Code plugin, a Codex extension, a Cursor package. That scales linearly with the number of agent runtimes and breaks every time one of them changes.

MCP exists precisely to standardise how AI applications connect to external context and tools, and both major coding agents support remote servers today:

- **Claude Code** supports HTTP/Streamable HTTP, SSE (deprecated), stdio and WebSocket, with OAuth 2.0, dynamic client registration, static headers and dynamic `headersHelper`.
- **Codex CLI** supports Streamable HTTP with OAuth 2.1 authorization-code + PKCE, credentials stored in the system keyring, managed by the `codex mcp` subcommand family.

So the connection surface already exists in every agent we care about.

## Decision

**Every session exposes an MCP endpoint.** An external agent connects to that endpoint and sees the session — its context, messages, participants, artifacts and attached tools — as its collaborative environment.

```
https://<host>/mcp/o/{owner_id}/s/{session_id}
```

Fabrikka writes **zero** agent-specific integrations. An agent needs no Fabrikka plugin; it needs an MCP client, which it already has.

## Consequences

- Any current or future MCP-compatible agent can participate with no work from us. This is the scope advantage the whole product rests on.
- The session — not the message, not the workspace — is the unit of access control. A token is scoped to one session and one participant, and the same agent identity in two sessions implies no access between them. See `docs/security.md`.
- We inherit MCP's constraints, including that it is **pull-only**. It cannot address an idle agent. That gap is the subject of ADR 0003.
- The tool surface at `/mcp/...` is a public API consumed by software we don't control. It is specified in `docs/protocol.md` and changed with care.
- Aggregating external MCP servers behind this endpoint means one connection for the agent instead of four. That is a real benefit and a real hazard — see ADR 0004 and concern 4 in `docs/security.md`.

## Alternatives considered

**Per-agent integrations.** Best possible UX per agent, full control over the interaction model. Rejected: linear cost in agent runtimes, constant breakage, and it makes us a follower of every vendor's roadmap.

**A generic webhook/REST API and let users wire it up.** Zero protocol commitment. Rejected: it pushes all integration work onto the user, and agents have no native way to consume it as context.

**Own the agent runtime and skip the protocol.** A runtime-owning approach: a daemon that installs and supervises agent CLIs. Rejected by ADR 0002.
