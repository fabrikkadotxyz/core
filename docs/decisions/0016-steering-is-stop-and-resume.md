# 0016 — Steering is stop-and-resume, not interruption

**Status:** Proposed
**Date:** 2026-09-29

## Context

The thesis behind M10/M12 asks that anyone be able to "drop into the same live
agent session to watch it work, **redirect it**, and hand it off." Today a mention
arriving while an agent is working **queues a second run**. There is no way to say
"no, look at the other file." The only mid-flight control is the kill switch.

So "redirect it" needs building. The question is what it can honestly be, because
neither runtime lets us do the obvious thing.

- **Spawned runs** are a closed invocation. `claude -p "<prompt>"` and
  `codex exec "<prompt>"` take their instructions up front; there is no channel to
  send a correction into a running process. Its stdin is not a prompt.
- **Live Claude Code sessions** can receive a channel push mid-run, but Anthropic's
  own documentation is explicit about when it lands: events "queue into the session
  and are processed in order… delivered together on the next turn." A push does not
  interrupt the turn in progress.

There is no API, in either runtime, for changing a model's instructions while it is
mid-thought. Building a feature called "redirect" that silently means "your
correction applies in a few minutes" would be the same category of dishonesty as a
kill switch that cannot kill.

## Decision

**Steering stops the current run and resumes the agent's thread with the
correction. It does not interrupt a model mid-thought, and the UI says so.**

Two paths, with genuinely different behaviour, surfaced differently:

### Spawned runs — stop and resume

1. The correction arrives and is recorded as a message.
2. The in-flight child is stopped, the same way the kill switch stops it.
3. A new run starts **with the provider's resume handle**, so the thread continues
   rather than restarting cold:
   - Claude Code: `--resume <session_id>`, which we already capture.
   - Codex: **no resume** — `codex exec resume` rejects `--approve-for-me`, so a
     resumed run would stall on the first approval with nobody to answer (found at
     M5). A steered Codex run starts fresh, and the UI says so.
4. The new run's prompt carries the original request, what the agent had already
   established, and the correction.

The agent keeps its context and loses only the work in flight. That is the best
available, and it is a real improvement over "queue a second run that repeats the
first's reading."

### Live sessions — the correction lands on the next turn

No stop, no restart: the push goes in and Claude picks it up when the current turn
ends. The timeline marks it **"will be picked up when the current turn finishes"**
rather than implying immediacy.

Stopping a live session is deliberately not offered. The turn is happening in the
user's own terminal, against their files, possibly mid-edit; reaching in to abort it
is not ours to do. The kill switch already declines to make that promise
([ADR 0012](0012-halt-is-server-side-termination-is-cooperative.md)).

### Only someone who may direct the agent may steer it

Steering routes through the existing delivery gate
([ADR 0010](0010-bridge-proxies-and-gates-at-source.md)) unchanged: an untrusted
mention cannot steer any more than it can start a run. Stopping work in flight is
strictly more disruptive than starting it, so it cannot be the weaker permission.

The **kill switch stays separate and available to any member**: stopping everything
is a safety control, while redirecting is participation.

## Consequences

- "Redirect it" becomes true in the only sense the runtimes permit, and the
  interface states which sense.
- Work in flight is lost on a spawned steer. Resuming the thread limits the cost to
  the current step rather than the whole investigation.
- Codex steering is worse than Claude Code steering, because Codex cannot resume
  under auto-approval. A real vendor asymmetry, recorded rather than smoothed over,
  as at M5.
- Rapid corrections could thrash: stop, resume, stop, resume. Needs a floor — a
  correction within a couple of seconds of the last one coalesces rather than
  restarting again.
- The turn budget counts each resumed run, so a steering war exhausts it and pauses
  the session. That is the correct outcome and needs no special case.
- `runs` must be addressable (from [ADR 0015](0015-activity-is-a-redacted-summary.md)),
  so a correction can name the run it is correcting rather than racing.

## Alternatives considered

**Interrupt the model mid-thought.** What "redirect" implies, and what everyone
will assume it means. Rejected because it is not possible: neither runtime exposes
it, and pretending otherwise would ship a control that quietly does something else.

**Queue the correction and let the current run finish.** Already the behaviour, and
it is honest. Rejected as insufficient: the agent then spends minutes finishing
work everyone can already see is wrong — exactly the frustration the thesis
describes.

**Stop the run and start fresh, without resuming.** Simpler, uniform across
providers, no resume handles to track. Rejected: it throws away everything the
agent established and makes steering feel punitive, so people would avoid using it.

**Let anyone in the session steer.** More collaborative, and matches "anyone on a
team should be able to redirect it." Rejected: steering stops work in flight, which
is more disruptive than starting it. An agent holds its owner's filesystem and
tokens, and the gate exists for that reason. The kill switch remains open to
everyone for the case where something is genuinely wrong.
