# 0012 — Halting is server-side; terminating a run is cooperative

**Status:** Accepted
**Date:** 2026-09-28

## Context

M6 adds the last two rails: a **turn budget** that stops runaway agent activity,
and a **kill switch** for a human who wants everything to stop now.

Both are "make it stop" controls, and both run into the same fact: since ADR 0011,
the process doing the work is on the **user's machine**, not ours. A spawned
`claude -p` or `codex exec` is a child of a runner the user started. The server
has no way to signal it directly.

That splits "stop" into two things that are easy to conflate and must not be:

- **Stop sending work.** Entirely the server's decision, and absolute.
- **Stop work already running.** Only the runner can do that, so it is a request.

A kill switch that claims to do the second but can only do the first is worse than
one that is honest, because it will be trusted at exactly the wrong moment.

## Decision

### One pause, two causes

There is a single session-level state — *agents paused* — reached either by a
human hitting the switch or by the turn budget running out.

```
sessions.agents_paused_at      timestamptz   -- null = agents active
sessions.agents_paused_reason  text          -- manual | turn_budget
```

One mechanism, so there is one thing to test and one thing to explain. A human
resumes both the same way, and the UI says which cause it was.

### Halting delivery is guaranteed; aborting a run is best-effort

**Server side, absolute:** while paused, `deliverMentions` sends nothing. No
channel push, no spawn. This holds regardless of what any local process does,
because the server simply never sends. A modified bridge gains nothing.

**Runner side, cooperative:** the server broadcasts an `abort` frame to every
connection for the session. A runner receiving it kills its in-flight child and
clears its queue. This is a *request* — a runner that is wedged, offline or
modified will not comply, and the server cannot make it.

The UI says this plainly rather than implying a guarantee:

> Agents paused. No new work will be sent. Runs already in flight are asked to
> stop; a run that has lost contact may finish on its own.

**A channel push cannot be recalled at all.** Once Claude Code has the event, the
model is mid-turn in the user's own terminal, and nothing in this system can reach
into that. Pausing stops the *next* push, not the current turn. Saying so is the
whole point.

### The budget counts deliveries, per session, in a rolling window

A *turn* is one delivery to one agent — a channel push or a spawn. The budget is
**20 turns per 10 minutes, per session**, and exhausting it pauses the session.

Per **session**, not per agent, because the failure being prevented is a
conversation between agents. Two agents each politely under their own cap still
produce an unbounded loop between them; only a shared budget sees it.

Counting **deliveries** rather than messages or tokens is deliberate: a delivery
is exactly the thing that causes an agent to act, it is already the chokepoint
every path funnels through, and it is countable without inspecting content.

Exhaustion is **not** silent. It posts to the timeline and surfaces in the UI, for
the same reason every other refusal does (ADR 0010): a session that has quietly
stopped responding is indistinguishable from one that is broken.

## Consequences

- An agent mid-turn in a live Claude Code session will finish that turn after a
  pause. This is a real limit of channels, not an implementation gap, and the UI
  states it rather than hiding it.
- A spawned run is usually killable, because the runner is normally healthy and
  connected. "Usually" is the honest word.
- The budget is per session, so a busy legitimate session can hit it. That is the
  correct trade for loop safety, and resuming is one click. If it proves annoying
  in practice, raise the number rather than scoping it per agent.
- One paused state covers both causes, so there is no way to be manually paused
  and budget-paused at once with unclear precedence.
- The budget window is in Postgres, not memory, so it survives a restart and works
  with more than one server process.

## Alternatives considered

**Have the server kill the process.** Simplest to reason about and a real
guarantee. Impossible: the process is on the user's machine, which is the whole
point of ADR 0011. Pretending otherwise would mean a kill switch that silently
does nothing whenever it matters most.

**Per-agent budgets.** Fairer, and a chatty agent cannot exhaust everyone else's
allowance. Rejected as the primary control: it does not see a two-agent loop,
which is the failure mode that motivated having a budget at all. Worth adding
*beside* a session budget later, never instead of one.

**Count tokens or model cost instead of turns.** Closer to the thing anyone
actually cares about. Rejected: we do not see token usage — the agent runs under
the user's own credentials, by design — so it is not ours to count.

**Pause automatically on any untrusted mention.** Maximally cautious. Rejected:
untrusted mentions are already never delivered (ADR 0010), so pausing the whole
session for one would let any member halt everyone else's agents at will.
