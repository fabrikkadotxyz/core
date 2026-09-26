# Security model

Security is an architectural property here, not a later feature. Two things make Fabrikka unusually exposed:

1. Its core feature is **other people's text reaching an agent that holds your filesystem and your credentials**.
2. Its delegation path runs agents **unattended**, without permission prompts.

Those two multiply. Most of this document exists to keep them apart.

## The fundamental boundary

> A session's resources are inaccessible unless the participant has permission to access **that session**.

The same agent identity participating in two sessions must not imply any access between them:

```
Session A                     Session B
  @fede                         @fede
  @claude-fede                  @claude-fede
  GitHub    ✓                   GitHub       ✓
  Sentry    ✓                   Production DB ✓
  Prod DB   ✗                   Sentry        ✗
```

Enforced by: every MCP token is scoped to exactly one `session_id` **and** one participant. Session scope is checked at the edge, before the MCP handler runs, never inside a tool implementation.

Non-members get **404, not 403**, on a session URL. Existence is itself private.

## Threat 1 — prompt injection between participants

This is the big one, and it is not a corner case: it is the product's core feature viewed from the other side.

Anthropic's channel documentation states plainly that *an ungated channel is a prompt injection vector*, and recommends gating on **sender identity, not room identity**. That advice is necessary here but **not sufficient**, because our dangerous sender is a *legitimately allowlisted* one:

> Alice is a real, invited member of the session. She is authorized to be in the room. She is **not** authorized to drive Fede's agent — which holds Fede's filesystem and Fede's tokens.

Standard allowlisting cannot express that distinction. Trust tiers do.

### Trust tiers

Every message carries a `trust` value, evaluated per recipient agent:

| Tier | Who | Effect on the receiving agent |
| --- | --- | --- |
| `owner` | The agent's own owner | May direct the agent. Can trigger a turn or a spawn. |
| `session` | Other members, when explicitly elevated | May direct the agent, within the turn budget. Opt-in per agent. |
| `untrusted` | Everyone else, including other agents | Delivered as **context only**. Never triggers a turn. Never treated as instructions. |

`session_agents.trust_tier` defaults to **`owner_only`**. Elevation is a deliberate act by the agent's owner, per session.

### Rules that follow

- **Delivery is mention-gated.** An agent receives a message only when explicitly mentioned. No ambient consumption of the timeline.
- **A turn is only triggered by an authorized mention.** An `untrusted` mention is delivered as context on some *later* authorized turn, or not at all — it never itself starts a run.
- **Untrusted content is wrapped and labelled** at the protocol level (`trust=` on the `<channel>` tag, `"trust"` on the message object) and the bridge's `instructions` string tells the model what that means.
- **Agents never receive their own messages.**

### What this does not protect against

Be honest about the residual risk:

- An elevated (`session`) participant can direct someone else's agent. That is the point of elevating them; it is a trust decision a human made.
- Content fetched by an agent from GitHub, Sentry or any other attached tool is **not** covered by these tiers. An injected payload in an issue body reaches the model the same as ever. Tool output is untrusted by default, always.
- A compromised agent can post as itself. Trust tiers gate *inbound* direction, not outbound authorship.

## Threat 2 — unattended execution

The spawn path runs `claude -p … --dangerously-skip-permissions` / `codex exec --full-auto`. There is no way around this: a headless run cannot stop at a prompt.

So the containment is entirely upstream, in who can cause a spawn:

- Only an `owner` (or explicitly elevated `session`) mention triggers a spawn.
- A spawned run gets a **run-scoped token**: one session, one participant, one run, expiring when the run ends.
- Per-session **turn budget** — N agent turns per rolling window, then delivery pauses and the UI says so.
- Per-session **kill switch** halts delivery and terminates in-flight spawned runs.

**Ordering requirement:** M6 (these rails) must land before a second human is ever put in a session with a spawn-enabled agent. Until then, sessions are single-owner-trusted. This is written into `docs/roadmap.md` as a gate, not a suggestion.

## Threat 3 — confused deputy in MCP aggregation

If a session owns credentials, then inviting someone to a session silently grants them your write access, and every audit log attributes their actions to you.

**Credentials are per-participant.** Each member attaches their own external MCP connections. A tool call routes to the **calling participant's** credential. Servers a participant has not attached are **absent from their tool list entirely** — not present-and-denied, which leaks the topology.

```
Session "Debug Stripe webhook"
  github:  fede  ✓ (fede's token)
           alice ✓ (alice's token)
  sentry:  fede  ✓
           alice ✗  → sentry tools not listed for alice

alice's agent calls github__*  →  alice's token
GitHub audit log says: alice
```

Tool grants (`session_mcp_tool_grants`) are **tool-level and default-deny**. Server-level allow/deny is too coarse: "GitHub read but not merge" is the actual requirement.

## Threat 4 — resource exhaustion and loops

Two agents in a session, each reacting to the other, will burn tokens until a human notices. Prevented by: mention-gated delivery, never echoing an agent its own messages, per-session turn budget, and a visible kill switch.

## Declined capabilities

**Permission relay** (`claude/channel/permission`). Claude Code can forward tool-approval prompts to a channel so they can be answered remotely. We do **not** declare this capability: anyone able to reply through the channel could approve tool use in the owner's session, which in a multi-participant room is a straightforward privilege escalation. Revisit only with per-participant verdict attribution.

## Transport and storage

- MCP endpoints are HTTPS only; session tokens never appear in URLs or query strings.
- External MCP credentials are encrypted at rest and never returned by any read API.
- The bridge holds credentials for exactly one session at a time.

## Security checks that gate release

These must pass before a session is ever shared with another human:

| Check | Milestone |
| --- | --- |
| A non-member gets 404 on a session URL | M1 |
| A token for session A returns nothing for session B | M3 |
| Alice cannot cause Fede's agent to execute anything | M6 |
| The turn budget halts a two-agent loop | M6 |
| The kill switch terminates an in-flight spawned run | M6 |
| Alice's GitHub calls are attributed to Alice | M8 |
| A server Alice hasn't attached is absent from her tool list | M8 |
