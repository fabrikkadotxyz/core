# 0010 — The bridge proxies upstream, and delivery is gated at the source

**Status:** Accepted
**Date:** 2026-09-27

## Context

M4 adds lane B: real-time push into a Claude Code session that is already
running, with the user's repo open and their permissions intact. The mechanism is
Claude Code's `claude/channel` capability, which is **stdio only**, so it needs a
local process. That process is the bridge.

Three questions had to be answered.

**1. Does the bridge reimplement the session tools, or proxy them?**

An agent configured with the bridge should not also have to configure the HTTP
endpoint — two MCP servers for one session is bad setup and worse mental model.
So the bridge has to offer the session tools. It can either reimplement them
against a REST API, or act as a client to the session's own MCP endpoint.

**2. Where does delivery get gated?**

A channel push *starts a turn*. Whatever reaches the bridge, Claude acts on. If
the bridge decides what to act on, the security boundary lives on the user's
machine, in a process they can edit.

**3. Is `reply` a separate tool?**

Anthropic's channel reference shows two-way channels exposing a `reply` tool. But
lane A already has `post_message`, which does exactly that.

## Decision

**1. The bridge proxies. It holds no tool logic of its own.**

At startup it connects as an MCP client to the session's own HTTP endpoint
(`/mcp/o/{owner}/s/{session}`), lists the tools it finds, and re-exposes each one
over stdio, forwarding calls verbatim.

Consequences that made this the obvious choice: the bridge gains M7's artifact
tools and M8's aggregated GitHub and Sentry tools **with no code change**, there
is exactly one implementation of every tool, and the bridge cannot drift from
lane A because it *is* lane A with a different transport in front.

This is also why the two SDK generations (ADR 0005) sit comfortably together: the
bridge is a **v1 stdio server** (required for the channel handshake) wrapping a
**v2 HTTP client** (required to speak to our own endpoint). Different packages,
no conflict, and the reason for each is local and legible.

**2. Delivery is decided by the server, never by the bridge.**

The server evaluates mention-gating and trust and pushes only what the agent is
permitted to act on. The bridge is a dumb pipe: whatever arrives, it forwards.

This matters because the bridge runs on the user's machine as a process they
control. A security boundary enforced there is not a boundary. Putting it on the
server means a modified or hostile bridge gains nothing — it can only receive
what the server was already willing to send.

So the gate lands **at M4, not M6**:

| Rule | Effect |
| --- | --- |
| Mention-gated | An agent is pushed a message only when explicitly mentioned. No ambient timeline consumption. |
| Never its own | An agent is never pushed a message it authored. |
| `owner_only` (default) | Only the agent's **owner's** mentions are delivered. |
| `session_trusted` | Any member's mentions are delivered. |

A mention that fails the gate is **not silently discarded**. The server emits a
`mention.blocked` event to the browser so a human can see that Alice addressed
Fede's agent and nothing happened, and why. Silent non-delivery would be
indistinguishable from a bug.

M6 then adds what remains: the turn budget, the kill switch, and the same gate
applied to the spawn path.

**3. There is no separate `reply` tool. Replying is `post_message`.**

The channel `instructions` string tells the model to reply with `post_message`,
which is already proxied. One way to post a message, whichever lane you arrive
on. `docs/protocol.md` is updated accordingly — the earlier draft specified a
`reply` tool before lane A existed.

## Consequences

- The bridge is small and mostly transport. Most of what could go wrong in it is
  a connection problem, not a logic problem.
- Startup cost: the bridge must reach the HTTP endpoint before it can advertise
  tools. If the server is unreachable, it starts with the channel capability and
  no tools, and logs why — rather than failing to start, which would leave Claude
  Code reporting a dead MCP server with no explanation.
- One extra hop per tool call (stdio → bridge → HTTP → Postgres). Irrelevant
  next to model latency.
- Because the bridge speaks to a *session-scoped* endpoint with a
  *participant-scoped* token (ADR 0009), it inherits the entire security boundary
  for free. It cannot reach another session even if it tried.
- All channel-specific code is confined to one module. Channels are a research
  preview whose contract may change, so the blast radius of a change is one file
  — as `docs/protocol.md` promises.

## Alternatives considered

**Reimplement the tools in the bridge against a REST API.** No extra hop, and the
bridge would work with the server offline for reads if it cached. Rejected: two
implementations of every tool that must agree forever, and every future tool has
to be added twice. It also needs a second token-authenticated API surface beside
the MCP one.

**Bridge decides delivery, subscribing to the whole session stream.** Simpler
server, and the bridge could offer local filtering options. Rejected outright:
it moves the prompt-injection boundary onto the user's machine into a process
they can trivially modify. The server must not be willing to send what the agent
should not act on.

**Push everything and let the model judge trust.** The `trust` field is already on
every message, and models are reasonably good at ignoring instructions in data.
Rejected as the *only* control: a channel push starts a turn, so this burns tokens
on every message in the session and makes "did not act" depend on the model
behaving. Defence in depth — gate delivery *and* label trust.

**Keep a separate `reply` tool for symmetry with Anthropic's examples.** Rejected:
two ways to post the same message, differing only in which transport suggested
them, is a distinction with no meaning to a user reading the timeline.
