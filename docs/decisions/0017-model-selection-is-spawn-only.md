# 0017 — Model selection is spawn-only, opaque, and reported

**Status:** Proposed
**Date:** 2026-09-29

## Context

"Which model is this agent using, and can I change it?" is one of the first
questions anyone asks of a product with agents in it. The obvious answer is a
dropdown on each agent.

The obvious answer is mostly not available to us, and the reason is
[ADR 0002](0002-do-not-own-the-agent-runtime.md): we do not own the agent runtime
and we hold no model credentials. That has a consequence nobody notices until they
try to build this:

| Lane | Who chose the model |
| --- | --- |
| Live session (channel) | The user, when they started `claude` in their terminal |
| Any MCP client | The user, in their own client's config |
| Spawned run | **Us**, because we build the command line |

On two of three lanes the model is already decided before Fabrikka is involved.
A dropdown on an agent attached by channel would be a control that silently does
nothing — the same category of dishonesty as a kill switch that cannot kill
([ADR 0012](0012-halt-is-server-side-termination-is-cooperative.md)) or a
"redirect" that means "in a few minutes"
([ADR 0016](0016-steering-is-stop-and-resume.md)).

There is a second, smaller question underneath: if we do pass a model through,
should we offer a list?

## Decision

### Selection applies to spawned runs only

An optional `model` on `session_agents`, null meaning **the agent's own default**.
It is passed as a flag when a run is spawned, and ignored everywhere else:

```
claude -p …       --model opus
codex exec …      -m gpt-5
opencode run …    -m anthropic/claude-sonnet-4.5
gemini …          --model gemini-2.5-pro
```

This is not runtime ownership. It is one flag on a binary the user installed and
authenticated themselves, exactly like `--dangerously-skip-permissions` already is.

The UI shows the field **only** where it has an effect. For a live session it says
the model comes from the agent's own configuration, rather than rendering an inert
control next to it.

### The value is an opaque string, never a curated list

No dropdown, no validation, no normalisation. A text field that is passed through
untouched.

Provider catalogues change on a weekly cadence, and the formats do not even agree
with each other: Claude Code takes aliases (`opus`) or full names, OpenCode requires
`provider/model`, Gemini takes its own identifiers. A curated list would be stale
within a fortnight, and a stale list is worse than a text field because it silently
withholds the model someone wants.

If the value is wrong the provider says so, in its own words, and that error
surfaces as a failed run — which is a better error than anything we could invent.

### What actually ran is recorded and displayed

Both providers report the model in their event stream. Verified against Claude Code:

```
system:    model = claude-opus-5-5
assistant: model = claude-opus-5-5
```

So a run records `model_used`, parsed from the stream, and the timeline shows it.
This matters most on the lanes where we cannot *choose*: we can still tell you what
a run used, which is the actual question behind "which model is this agent using".

Requested and used are kept as separate fields on purpose. An agent can fall back
(`--fallback-model` exists precisely for overload), so "we asked for opus" and "it
ran on sonnet" are different facts and conflating them would hide the interesting
one.

## Consequences

- The honest answer to "can I change the model?" is "on runs we start, yes; on your
  own session, that is your config" — and the interface says so rather than
  implying more.
- A typo reaches the provider and fails the run. Acceptable: the provider's error
  names the valid models, and a failed run is already visible in the timeline
  rather than silent (ADR 0011's relay).
- Every new adapter must map this one field to its own flag, which is one line, and
  must parse `model_used` from its stream, which is a few more.
- No model catalogue to maintain, and no dependency on provider APIs we do not call.
- Cost and token accounting stay out of scope. Usage is billed to the user's own
  credential, so it is not ours to see — the same reason the turn budget counts
  deliveries rather than tokens (ADR 0012).

## Alternatives considered

**A dropdown per agent, on every lane.** What people expect, and it looks complete.
Rejected: on channel and remote lanes it would change nothing, and a control that
appears to work is worse than an absent one.

**A curated model list per provider.** Nicer to use, prevents typos, and could show
context windows or pricing. Rejected: it goes stale weekly, requires tracking four
providers' catalogues, and the failure mode is withholding a model that exists. The
provider is the authority on its own catalogue.

**Ask the provider for its model list at runtime.** Fresh, and Codex exposes
`cloud-agents/{name}/models`-style endpoints. Rejected for now: it is a per-provider
integration each, for a text field that works without it. Worth revisiting if typos
turn out to be a real support burden.

**Store a model per session rather than per agent.** Simpler, and "this session runs
on sonnet" reads well. Rejected: two agents in a room may legitimately want
different models — a cheap one triaging and an expensive one reasoning — and that is
a reason to have two agents.
