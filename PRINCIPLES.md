# Principles

What we want from Fabrikka, what the person using it gets, and the rules that
settle an argument. Read this before `CLAUDE.md` (how we work) and
`ARCHITECTURE.md` (how it is built).

## What we want

A private room where people and the AI agents they already have work on one
bounded problem together, and nobody carries context between them by hand.

The MVP answers one question: *does it feel useful to have a private room where
I work with my existing agents and other people?* The success criterion, from
`docs/roadmap.md`: **nobody pasted context into an agent.**

## What the person gets

These are the promises. Everything else in this repository exists to keep them
true.

1. **Nothing to copy-paste.** Context, messages, files, decisions and tools live
   in the room. Every participant, human or agent, reads the same thing.
2. **Your agent, your credentials, your machine.** You bring the Claude Code or
   Codex you already pay for and trust. Fabrikka holds no model key and runs
   nothing on your behalf that you did not start.
3. **A record that outlives the chat.** Objective, decisions, outputs and
   handoffs stay with the problem. Another time zone, or a reader six months
   later, picks it up from the record.
4. **Privacy you can rely on.** Private by default. Existence is private: a
   non-member gets 404, not 403. Nothing leaves a session without a member's
   deliberate act ([ADR 0022](docs/decisions/0022-nothing-leaves-a-session-without-a-members-deliberate-act.md)).
   Growth never buys reach by weakening this.
5. **Their tools, in their place.** Vendors connect as the person, through the
   vendor's own MCP server ([ADR 0024](docs/decisions/0024-connections-are-categories-over-vendor-mcp-servers.md)).
   Run it in your own cloud or let us host it: the same code, and features
   appear when configured ([ADR 0029](docs/decisions/0029-the-core-is-a-library-a-deployment-extends-it.md)).
6. **Nothing to learn, nothing to paste.** Every feature path is five clicks or
   fewer. A paste per use is a failing design (`CLAUDE.md`, *Five clicks*).

## How we deliver it today

This is the mechanism we are betting on now. It is the current means, not the
identity of the project.

- **The session is itself an MCP** ([ADR 0001](docs/decisions/0001-session-is-an-mcp.md)).
  Any agent that speaks MCP joins with no plugin from us.
- **Fabrikka owns the session, not the agent** ([ADR 0002](docs/decisions/0002-do-not-own-the-agent-runtime.md)).
  It never installs, authenticates or supervises a runtime. The agent spawns
  the bridge.
- **Hybrid wake-up** ([ADR 0003](docs/decisions/0003-hybrid-wake-up.md)).
  A channel push when the agent is live, a spawn when nobody is at the terminal.

If this mechanism cannot deliver the promises above, we change the mechanism,
through a superseding ADR, and keep the promises. The promises do not bend to
the mechanism.

## Ground rules

What settles an argument, in order.

1. **The user's outcome wins.** When a design choice and a promise above
   conflict, the promise stays and the choice goes.
2. **Docs first.** The doc is the source of truth. `docs/protocol.md` is a
   public API that external agents bind to. An architectural choice gets an ADR
   before code (`docs/decisions/README.md`).
3. **Five clicks, at most.** Count them in the milestone's manual test.
4. **Private by default, and nothing leaks by convenience.**
5. **One code path.** No deployment-mode flag. Capabilities come from
   configuration. What a deployment adds is an extension outside the core.
6. **Security is architectural.** Other people's text reaches an agent holding
   someone's filesystem and credentials, sometimes unattended. Keep those two
   apart: gate at the source, one token per session and participant
   (`docs/security.md`).
7. **Simple to extend.** An output kind or an integration is one folder plus
   one registry line ([ADR 0023](docs/decisions/0023-an-output-kind-is-a-plug-in-module.md),
   [ADR 0024](docs/decisions/0024-connections-are-categories-over-vendor-mcp-servers.md)).
   If adding one takes more, the shape is wrong, not the contributor.
8. **Stories, not screens.** A feature is finished when a user story runs end to
   end with real accounts. A story that seems to need a dashboard, kanban,
   analytics or "AI insights" is probably the wrong story.
9. **One milestone at a time, with a human gate.** The manual test in
   `docs/roadmap.md` is a gate, not a suggestion. M6 safety rails come before a
   second human ever shares a room with a spawn-enabled agent.

## Deliberately not building

No built-in LLM provider. No Fabrikka-hosted Claude or Codex. No autonomous
orchestration, agent marketplace, workflows, kanban, RAG, vector database,
public sessions, billing, mobile, enterprise SSO or elaborate RBAC. The full
list and its exceptions live in `docs/roadmap.md`, *Explicitly not MVP*.

## Where the rest lives

| Doc | Holds |
| --- | --- |
| `CLAUDE.md` | How we work: docs first, five clicks, the milestone workflow |
| `ARCHITECTURE.md` | The design that delivers the promises today |
| `docs/roadmap.md` | The order, and each milestone's acceptance test |
| `docs/decisions/` | Why each decision is the way it is |
