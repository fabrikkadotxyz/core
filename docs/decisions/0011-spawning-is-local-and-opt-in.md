# 0011 — Spawning happens on the user's machine, and running the runner is the consent

**Status:** Accepted
**Date:** 2026-09-28

## Context

M4 delivers a mention into a Claude Code session that is **already running**. When
nothing is listening, the server reports `mention.blocked` with reason
`no_connection`. M5 fills that gap: start a fresh headless agent for the mention.

That immediately raises the question of *where*. And a harder one: a headless run
cannot stop at a permission prompt, so it runs with
`--dangerously-skip-permissions` / `--full-auto`. Something has to make that
acceptable.

## Decision

### Spawning is local. The server never spawns.

A useful run needs the user's repository, the user's `claude` or `codex` binary,
and the credentials those binaries already hold. All three live on the user's
machine. A hosted server has none of them, and giving it them would mean
uploading a repo and an API key — which is the opposite of the product.

So spawning is a second mode of the bridge, run by the user:

```
fabrikka watch --dir ~/code/myrepo
```

It is a **distinct connection kind** (`runner`, beside `bridge`), and delivery
prefers the live session when both exist:

```
@mention → bridge connection?  ──yes──> channel push (M4)
              │
              └─ runner connection? ──yes──> spawn a headless run (M5)
                    │
                    └─ neither ──> mention.blocked / no_connection
```

This keeps ADR 0002 intact. The runner shells out to a binary the user already
installed and already authenticated. It does not install, update, configure or
supervise an agent runtime, and it holds no model credentials.

### Running the runner is the consent for unattended execution

This is the part worth being explicit about. There is no `spawn_enabled` flag,
because a flag buried in a settings panel is a bad place to record "an agent may
execute code on my laptop without asking".

Instead the consent is the act itself: the user starts a process, in a directory
they chose, and it prints exactly what it will do before it does anything:

```
fabrikka watch
  session   : debug-stripe-webhook
  agent     : @claude-fede
  directory : /Users/fede/code/api
  on mention: claude -p … --dangerously-skip-permissions

  Runs start WITHOUT permission prompts. Only @fede can trigger them.
  Ctrl-C to stop.
```

Nothing is unattended that the user did not start, in a directory they named, with
the risk stated on screen. Closing the terminal ends it.

The delivery gate from ADR 0010 still applies unchanged and is still enforced
server-side, so "only `@fede` can trigger them" is a fact about the server, not a
promise made by a process the user could edit.

### Each run gets a run-scoped token

The spawned agent is given an `--mcp-config` pointing at the session endpoint with
a token minted for that run: same session, same participant, **30-minute TTL**,
revoked when the run ends.

The reason is blast radius. A spawned agent's config path is visible to the model,
its own transcript may be logged, and its output may be pasted into an issue. A
long-lived token in that position is a standing liability; a token that dies with
the run is not.

### If the agent does not post, the runner posts for it

The run's prompt tells the agent to reply with `post_message`. If the run finishes
and the agent posted nothing, the runner posts the final assistant text itself,
attributed to the same participant.

This is not redundancy for its own sake — it is the M4 lesson applied. In M4 the
model received a channel event, answered in its terminal, and posted nothing, which
from the browser is indistinguishable from a broken bridge. A run that produces no
visible result is the same failure. The fallback makes silence impossible.

It also papers over a real vendor difference: Claude Code accepts `--mcp-config`
so the spawned agent can post as itself, while `codex exec` takes its MCP servers
from its own config file, so a Codex run relies on the relay.

## Consequences

- Spawning only works while the user has a runner going. That is a real limit and
  the right one: "my machine executes code when I am not there" should require a
  process I started.
- Two local modes to explain. Mitigated by one binary and one `.mcp.json`-shaped
  setup, with the session UI generating both.
- The runner is a long-running local process, so it needs to survive server
  restarts. It reuses the bridge socket's reconnect-with-backoff.
- Concurrency has to be bounded, or ten mentions start ten agents against one
  working directory. One run at a time per agent, queue depth capped, extra
  mentions dropped with a note in the session rather than silently.
- The relay fallback can double-post if the agent posts *and* prints a conclusion.
  Resolved by checking for new messages from that participant during the run.
- `--dangerously-skip-permissions` is still what it says. M6's turn budget and
  kill switch are the remaining controls, and M6 is now the last thing between
  this and putting a second human in a session with a spawn-enabled agent.

## Alternatives considered

**Server-side spawning.** One place to operate and monitor, no local daemon.
Rejected: a hosted server cannot see the user's repo or binaries, so it would
require uploading both the code and the model credentials, and it would make
Fabrikka the thing that runs agents — ADR 0002 exists to prevent exactly that.

**A `spawn_enabled` flag per agent, with the server spawning via the bridge.**
Keeps one local process. Rejected: it puts the authorisation for unattended code
execution in a checkbox, far from the moment and the machine where it takes
effect. Starting a process in a directory is a much better record of intent.

**Ask for permission by relaying prompts to the browser.** Claude Code's channel
permission relay could forward prompts to a human. Rejected for now for the reason
in `docs/security.md`: anyone who can reply through the channel could then approve
tool use in the owner's session. Revisit with per-participant verdict attribution.

**Have the runner relay output only, with no MCP config for the spawned agent.**
Uniform across vendors and simpler. Rejected as the default: giving the agent the
session endpoint lets it read context and post as itself, which is the whole point
of the session being an MCP. The relay stays as the fallback.
