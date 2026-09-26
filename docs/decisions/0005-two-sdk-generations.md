# 0005 — Two MCP SDK generations in one repo

**Status:** Accepted
**Date:** 2026-09-25

## Context

The MCP TypeScript SDK split at v2. The monolithic `@modelcontextprotocol/sdk` (latest `1.30.1`) is replaced by separate packages — `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both `2.1.0` — implementing MCP spec revision `2026-07-28`. Framework adapters exist for Express, Fastify, Hono and Node; `@modelcontextprotocol/hono` is `2.0.1`.

v2 is the right choice for the remote endpoint: stateless-per-request handlers, current spec, the Hono adapter we want, and built-in OAuth metadata middleware.

But the bridge cannot use it. From Claude Code's own documentation:

> If you set `MCP_PROTOCOL_NEGOTIATION` to `auto` and a channel server negotiates MCP protocol revision 2026-07-28, it can't deliver channel messages, so Claude Code doesn't register it as a channel. Leaving the variable unset, or setting it to `legacy`, keeps stdio servers on the earlier handshake.

A channel server that speaks the current spec is **silently not a channel**. Events are dropped with no error returned to the server. Every official channel plugin uses the v1 `Server` class from `@modelcontextprotocol/sdk`.

## Decision

**Use both, in separate packages, deliberately.**

| Package | SDK | Why |
| --- | --- | --- |
| `apps/server` (remote endpoint, lane A) | `@modelcontextprotocol/server` **2.1.0** + `@modelcontextprotocol/hono` **2.0.1** | Current spec, stateless HTTP, Hono adapter, OAuth metadata middleware |
| `packages/bridge` (lane B) | `@modelcontextprotocol/sdk` **1.30.1** | v1 handshake is **required** for `claude/channel` to register |

The bridge must also never set `MCP_PROTOCOL_NEGOTIATION` to `auto` in any environment it controls or documents.

## Consequences

- Two MCP APIs in one repo. Contributors will find this surprising, which is exactly why it has an ADR and why `CLAUDE.md` points at it.
- The package boundary carries the distinction. Neither package imports the other's SDK; there is no shared MCP abstraction layer spanning them, and there should not be one — it would have to be the intersection of two deliberately different protocol revisions.
- `packages/types` holds shared *domain* types (messages, participants, trust) and no SDK types at all.
- This is temporary in principle. When channels leave research preview and support the current handshake, the bridge moves to v2 and this ADR is superseded. Nothing else should need to change.
- v1 has a documented 12-month offramp for the features deprecated in `2026-07-28`, so the bridge is not at risk of sudden breakage — but it is on a clock, and that clock should be checked when channels exit preview.

## Alternatives considered

**v1 everywhere.** One SDK, no surprise. Rejected: the remote endpoint would be on a deprecated transport line (HTTP+SSE is officially deprecated with a year-long offramp) and would miss the Hono adapter and OAuth middleware we want on the surface agents actually bind to.

**v2 everywhere.** Also one SDK, and current. Rejected: it does not work. The channel simply never registers, and it fails *silently*, which is the worst possible failure mode to design in.

**Wrap both behind an internal abstraction.** Rejected: the abstraction could only express the intersection of two protocol revisions that differ on purpose, and it would hide exactly the constraint that most needs to stay visible.
