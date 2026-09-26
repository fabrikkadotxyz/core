# 0002 — Fabrikka does not own the agent runtime

**Status:** Accepted
**Date:** 2026-09-25

## Context

Fabrikka needs agents to act on mentions. The most direct way to guarantee that is to run the agents ourselves.

That is a runtime-owning approach: a daemon that installs and supervises agent CLIs. It installs the agent runtimes, creates agents, holds their LLM API keys in its own configuration, and runs them in the background, with an adapter per tool (Claude Code, Codex, Aider, Goose, Gemini CLI and others). It works, and it buys clean multi-vendor parity: every agent behaves identically because the daemon drives them all the same way.

The pull toward this is strong, and it will recur every time a vendor lacks a capability we want.

## Decision

**Fabrikka does not own the agent. Fabrikka owns the session.**

Fabrikka never installs, updates, configures, authenticates or supervises an agent runtime. Concretely:

- **The agent spawns the bridge, not the reverse.** Claude Code reads `.mcp.json` and starts `fabrikka connect` as its subprocess. The bridge is a child of the agent.
- The spawn path (ADR 0003) shells out to a binary **the user already installed and already authenticated**. It manages no installation, holds no model credentials, and offers no catalog.
- We store no LLM API keys. Ever.

Fabrikka needs to know only: who is participating, what session they're in, what they can access, what has happened, what tools exist, what context is relevant, and who is being addressed.

## Consequences

- We are limited to what agent runtimes expose. When Codex lacks a channel equivalent, we do not close the gap by wrapping it — we accept the asymmetry (ADR 0003).
- We never inherit the install, update, auth and breakage surface of seven agent CLIs. This is the whole point: that surface is unbounded and not our product.
- Users keep their own model credentials and their own agent configuration. This is also a meaningful trust advantage when asking someone to put an agent in a shared room.
- Future agents work without our involvement, including ones that don't exist yet.
- **The bridge is where this rule will be tested.** It is a local process, it is tempting to give it lifecycle management, and each individual step will look reasonable. The moment it installs or supervises an agent, we are building an agent launcher instead of a session layer.

## Alternatives considered

**Own the runtime, with a supervising daemon.** Real-time multi-vendor parity, no dependence on vendor-specific push, no research-preview flags. Rejected: it makes us responsible for every agent's lifecycle, requires users to hand us LLM credentials, and converts the product from a session layer into an agent launcher competing directly with the vendors' own tooling.

**Own the runtime only for agents that lack push (i.e. Codex).** A narrower version of the same thing. Rejected: the line would move immediately. Once one adapter exists, the argument for the next is always "we already do it for Codex."

**Build on the Claude Agent SDK** to run supervised in-process agents. Rejected for the same reason, plus it binds the product to one vendor at the layer we most need to stay neutral.
