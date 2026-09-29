# 0015 — Activity is a redacted summary, not a transcript

**Status:** Accepted
**Date:** 2026-09-29

## Context

A session currently shows a `working` pill and then, eventually, an answer. Every
step the agent took went to `console.error` on the runner's machine, or into
someone's terminal. "Drop into a live agent session and watch it work" is not
true of what we built: the work happens off-screen, which is the same complaint
as a read-only transcript, one level in.

Fixing it means streaming what the agent is doing into the timeline. That sounds
like plumbing — the events already exist, the bus already fans out — but it
crosses a trust boundary nothing else in this system crosses.

**Agent activity is the owner's private work, and the session is shared.** Until
now, everything a member could see was something a participant chose to post. A
tool call was never authored for an audience:

- `Bash(curl -H "Authorization: Bearer sk-ant-…" …)` leaks the owner's credential
  to every member of the room.
- `Read(/Users/fede/clients/acme/contract.pdf)` leaks a path the owner never meant
  to share.
- Tool *output* can be the entire contents of a private file.

None of that is hypothetical: it is the ordinary content of an agent's work on
someone's real machine. Claude Code's own permission-relay design reaches the same
conclusion from the other direction — it masks credentials and elides long values
before relaying a prompt off-device.

## Decision

**Stream a summary of what the agent is doing. Never a transcript.**

What is streamed:

| Shown | Example |
| --- | --- |
| Tool name | `Read`, `Bash`, `github__list_issues` |
| One short descriptor, redacted | `src/retry.ts`, `ran the test suite` |
| Aggregate counts | `read 4 files` |

What is **not** streamed, ever:

- Tool **output**. The agent's conclusion is the thing it chose to say; its
  intermediate reading is not.
- Full command lines or full argument objects.
- Anything matching a credential shape, replaced with `[redacted]` before it
  leaves the runner.

Redaction happens **on the runner, before the event is sent** — not in the browser
and not on the server. The runner is the only place that sees the raw value, so it
is the only place where redaction prevents the secret from travelling at all.

### Activity is ephemeral, with a bounded per-run buffer

Activity events are **not** durable session content. They live in a capped
in-memory buffer per run (say 200 events), so someone joining mid-run catches up,
and are discarded when the run ends. The run's *outcome* is a message, which is
durable; the steps that produced it are not.

A run that emits four hundred tool calls should not leave four hundred rows in a
table forever, and nobody re-reads last Tuesday's tool calls. If that turns out to
be wrong, durability is additive.

### The agent's owner can turn it off

Per session, per agent: `activity_visible`, default **on**. Streaming your agent's
activity to a shared room is a reasonable default and an unreasonable
obligation — somebody working in a private repo inside a shared session gets to
decline without leaving the session.

### How much is visible depends on the lane, and that is not fixable here

| Lane | What can be streamed |
| --- | --- |
| **Spawned run** | **Everything.** The runner parses the agent's own event stream, so it sees every tool call |
| **Live session** | **Only tools called through us** — `post_message`, `read_messages`, aggregated integrations. Claude Code executes `Read`, `Bash` and the rest in the user's own terminal, and the bridge is not in that loop |

This is a property of how channels work, not an implementation gap. The bridge is
an MCP server the agent talks to; it never sees the agent's other tools.

It is also the less important half. The case the multiplayer thesis describes —
"agents running tasks that take hours, days, even weeks" with nobody watching — is
precisely the spawned run. A live session already has a human in front of it,
reading the terminal.

A future option, deliberately out of scope: Claude Code's `PostToolUse` hook could
post activity from the user's side. That would mean shipping a hook, which is
configuration in someone else's tool, so it needs its own decision.

### Activity is display data, never instructions

An activity event's text originates from tool arguments, which an agent can be
talked into shaping. It is rendered as inert text and is **never** delivered to
another agent as context, and never counted against the turn budget — it is not a
delivery and must not become an injection path between agents.

## Consequences

- "Watch it work" becomes true, which is the point.
- What you see is genuinely less than what the owner sees. A member watching
  cannot fully audit the run, and that is the correct trade: the alternative
  broadcasts private paths and secrets to the room.
- Redaction is best-effort. A secret without a recognisable prefix, or one spanning
  whitespace, will not be caught — the same limitation Claude Code documents. The
  defence is that output is never streamed at all, so the exposure is one short
  descriptor rather than a whole transcript.
- Late joiners see the current run but not previous ones. Acceptable: the outcome
  of a previous run is a message in the timeline.
- A `runs` concept has to exist, so activity can group and so M12 can address a
  run. That is a prerequisite either way.

## What building it changed

Two things were wrong in a way only the running system showed:

- **Buffered stdout replays the run after it ends.** The runner originally read the
  agent's whole output and parsed it on exit, so every step arrived *after* the
  answer. Every assertion about content passed and the feature was useless. Parsing
  is now incremental — a line is emitted the moment its newline arrives, with a
  held tail for lines that straddle chunks. `scripts/acceptance/m10.mjs` asserts
  the first step arrives **before** the agent's message, not merely that steps exist.
- **Concurrent frame handling reorders steps.** Each frame's handler awaits the
  database, so two frames arriving back to back finished out of order and published
  `post_message` before the `Read` it was based on. Frames from one connection are
  now handled one at a time.

Both failures are the same shape: the events were all present and the *sequence*
was wrong, which reads as the agent having done something it did not do.

> *Note, 2026-09-29, from testing the Codex lane:* Codex reports each item twice —
> once `item.started`, once `item.completed` with the same `id` — so every step
> appeared twice until the runner learned to read only the first. Its
> `item.completed` also carries `aggregated_output`, the command's real stdout: the
> "never stream output" rule is not abstract, it is a field sitting in the event we
> already parse. And because Codex shells out through `/bin/zsh -lc '…'`, the
> first-token rule yielded `Bash /bin/zsh` for every command until the wrapper was
> unwrapped. Details in [docs/protocol.md](../protocol.md#what-the-runner-reports-as-activity).

## Alternatives considered

**Stream everything, verbatim.** Maximum transparency, best "watch it work" feel,
and simplest to build — pipe the stream straight through. Rejected: it publishes
the owner's command lines, file paths and file contents to everyone in the room.
A feature that makes a shared session unsafe for real work is not a feature.

**Stream everything but let the owner opt in.** Keeps fidelity, makes exposure a
choice. Rejected as the default shape: almost nobody reads what an opt-in actually
exposes, and the first time it leaks a token the lesson is expensive. Summary-by
-default with an off switch fails safe; verbatim-by-consent fails loud.

**Persist activity as durable rows.** Full history, auditable after the fact, and
it would support "what did this agent do last week". Rejected for now on volume
and value: hundreds of rows per run for something nobody re-reads. Revisit if an
audit requirement appears — at which point the question becomes retention policy,
not storage.

**Redact on the server instead of the runner.** One implementation, easier to fix
centrally. Rejected: the secret would already have left the user's machine. The
only place redaction prevents travel is before the wire.
