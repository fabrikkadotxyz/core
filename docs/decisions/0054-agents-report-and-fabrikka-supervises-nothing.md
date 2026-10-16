# 0054 — Agents report; Fabrikka supervises nothing

**Status:** Proposed (written 2026-10-16 for the owner's review before anything is built)
**Builds on:** [ADR 0002](0002-the-agent-spawns-the-bridge.md) (the agent
spawns the bridge, never the reverse), [ADR 0011](0011-spawning-is-local-and-opt-in.md),
[ADR 0015](0015-activity-is-redacted-before-it-leaves-the-machine.md),
[ADR 0016](0016-steering-is-stop-and-resume.md), the compatibility rules in
`docs/protocol.md` (herdr item 6) and M15 slice 1 (the `blocked` state).
Herdr item 3 in `docs/mvp.md`.

## Context

Fabrikka learns what an agent is doing in three ways, and all three are ours
to maintain. A live Claude Code session attaches through the channel plugin.
A headless run is spawned by the runner through an adapter written for that
tool: Claude Code, Codex, OpenCode, each a few hundred lines that know how to
launch it, which flags confine it to the folder's policy, how to hand it the
session's MCP server, how to read its output stream for steps and state, and
how to resume it. Any other tool can only use the remote MCP endpoint, which
gives the model the session's tools and gives Fabrikka nothing about its
state.

Each adapter is two things. **Launching and confining** is specific to the
tool and must stay verified by a spike, because the trust model rests on it
(ADR 0027, 0032, 0047). **Observing** (working, blocked, which step, how to
resume, has it exited) is read today from each tool's output format, which
differs per tool and rots when a vendor changes a field. Antigravity is stuck
on the first half, and the second half is what every new tool costs again.

herdr supports twenty-five agents with none of that: when its environment
variables are set, a tool (or a wrapper, hook or plugin around it) makes three
documented calls in the background, ignoring failures: report state, report
the resume command, release on exit. The agent reports; the harness
supervises nothing. That shape is ADR 0002's rule stated from the agent's
side.

## Decision

**Fabrikka publishes a reporting contract: three calls an agent may make
about its own run. Reports replace the observing half of adapters; they
never replace launching and confining, and they never bind an agent to a
room.**

### The contract

Anything Fabrikka runs gets three environment variables, and anything that
holds them may report:

| Variable | Holds |
| --- | --- |
| `FABRIKKA_REPORT_URL` | Where to report: `https://<host>/bridge/o/{owner}/s/{session}/report` |
| `FABRIKKA_RUN_TOKEN` | The run's own token (M10), already minted per run; it names the participant and the run, and it expires with the run |
| `FABRIKKA_RUN_ID` | The run this process is |

Three reports, each one HTTP `POST` to the report URL with the run token as
bearer and a JSON body:

| Body | Meaning |
| --- | --- |
| `{ report: 'state', status, reason?, detail?, completed? }` | The same words as the bridge's status frame (M15 slice 1): `working`, `blocked` with `reason` and a redacted `detail`, `idle` with `completed` |
| `{ report: 'resume', argv }` | How to continue this run later: an argv, validated before it is stored (below), executed only when a person asks to resume, on the machine that owns the run (ADR 0016) |
| `{ report: 'release', status? }` | This run is over: `done`, `failed` or `stopped`; absent means `done`. Ends the run as `run.end` does |

The server turns each into the frame the bridge would have sent, through the
same checks: the token must own the run, the run must be in this session,
sizes are capped (`detail` 120, `reason` 32), unknown `report` kinds and
unknown `status` values are ignored and answered `202` all the same, so an
older or newer reporter never fails. Sixty reports a minute per run; beyond
that, `429` and nothing stored.

For hooks and shell wrappers that cannot speak HTTP comfortably, the client
ships one command that reads the variables and posts:

```
fabrikka report state blocked --reason permission --detail "Bash"
fabrikka report resume -- claude --resume 8f3c…
fabrikka report release --status done
```

It exits 0 whatever happens, because a report must never break the tool
that made it.

### The boundary

- **A report is a fact about the reporter's own run.** It cannot name
  another run, another participant or another session: the token decides
  all three. It cannot post a message, change a grant or touch an output;
  those are the session's MCP tools, for the model, with their own gate.
- **A report is never a command to Fabrikka.** The resume argv is data,
  stored only if it passes herdr item 5's rules: the first word is a bare
  command found on `PATH` of the machine that owns the run, no argument
  holds an apostrophe or a control character, at most 64 arguments and
  8 KiB in all, and the reporter owns the run. It is executed only by M15's
  resume, on that machine, inside the folder and policy the run already
  had. The server never runs it, and the browser never sees it whole: the
  room shows the first word.
- **Activity stays as it is.** Steps are redacted on the bridge before they
  cross the wire (ADR 0015); a tool reporting its own steps would have to
  redact to that standard, and nothing today can promise it. A fourth
  report may come later, with its own rules; it is not in this contract.
- **Silence is allowed.** A tool that reports nothing is `working` from
  launch to exit and `idle` after, as the runner reports today on its
  behalf. Reporting only adds; it never removes what the runner provides.

### What changes for each way in

| Way in | Before | After |
| --- | --- | --- |
| Spawned run through an adapter (Claude Code, Codex, OpenCode) | The adapter parses the stream for state and resume | Unchanged. The adapter keeps parsing; the variables are set as well, so a hook or the tool may report, and a report wins over parsing for `blocked` and `resume` |
| Live Claude Code session (channel) | The bridge reports `working` when it pushes a mention; nothing else | Unchanged by this ADR. Item 4 (hooks) would make it report `blocked` and `completed` through this contract |
| **Any command, run for a room** (new) | Not possible: only the remote MCP endpoint, with no state | `fabrikka run --session <ref> -- <command…>`: the client acts as the runner for an agent already added to the room (*Connect another way*), sets the variables, starts the command, reports `working` at start and `idle, completed` at exit itself (the release-on-exit, even for a tool that knows nothing of Fabrikka), and relays whatever the command reports. **Full policy only**: nothing confines an arbitrary command, and the picker says so |
| Remote MCP endpoint | The model has the tools; Fabrikka sees no state | Unchanged, and still the way in for a tool that cannot run on a machine of yours |

### What it does not change

The agent spawns the bridge, never the reverse. Folder policies are enforced
by each tool's own controls, verified per tool, and a tool with no verified
policy is offered in *Full* folders only, as ADR 0032 decided for Codex. The
session's MCP tools and their gate are untouched. The protocol's
compatibility rules apply to the three reports as to every frame.

## Consequences

- A new tool costs its launch line and its confinement flags. The parser is
  optional, and absent for a tool that reports.
- Antigravity has a path that does not need a per-run config: the session's
  MCP server set up once at user level with the token from the environment,
  and state through reports. Still to verify: that its headless mode runs
  with those variables set.
- The `blocked` state built in M15 slice 1 gets its first real source once
  item 4's hooks call `fabrikka report`.
- A second way of learning state exists beside the parsers for as long as
  the three adapters keep theirs. The rule above (a report wins for
  `blocked` and `resume`, the runner's own `working`/`idle` stays) keeps the
  two from fighting; the M15 check pins it.
- A new surface, documented in `docs/protocol.md` as section 4, with the
  three reports, the variables, the limits and the boundary.
- A person who runs a command for a room is trusting that command as they
  trust *Full*: the picker and the roadmap say so, and the kill switch still
  stops it.

## Alternatives considered

**Reports over the bridge socket instead of HTTP.** The socket belongs to
the runner process; a hook or a wrapper inside the tool's process has no
handle on it. HTTP with the run token is reachable from anything, and the
token is already minted per run.

**Let a report bind an agent to a room.** Easy to want (one variable, and
anything joins) and the wrong trust: joining a room is adding a participant,
which is the owner's act through Setup. A report names a run it already owns.

**Report activity too.** Rejected for now (ADR 0015): redaction happens on
our side of the wire, and a tool's own idea of a safe descriptor is not one
we can check.

**Drop the parsers now.** Rejected: the three adapters are verified and in
use; they keep their parsing until a reporting path is checked to do at
least as well, tool by tool.
