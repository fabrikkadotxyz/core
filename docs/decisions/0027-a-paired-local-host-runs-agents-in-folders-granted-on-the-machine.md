# 0027 — A paired local host runs agents in folders granted on the machine

**Status:** Proposed
**Date:** 2026-10-04
**Extends:** [ADR 0011](0011-spawning-is-local-and-opt-in.md). The CLI runner it describes stays.

## Context

ADR 0011 made spawning local and opt-in: `fabrikka watch --dir <folder>` runs on
the user's machine, and **running it is the consent**. That got the trust model
right and the experience wrong:

- Adding your agent to a session means copying a setup block, with a token in it,
  into a terminal. That happens **once per session and per agent**, which fails
  the working agreement that every feature path takes at most five clicks, with
  no copy-paste per use (CLAUDE.md).
- The runner lives in a terminal window and dies with it.
- Claude Code runs with `--dangerously-skip-permissions`, no sandbox at all
  (docs/operations.md). The remaining controls are the delivery gate, the turn
  budget and the kill switch.

People want a small app on their own computer that connects to the server once,
and from then on can start their agents in certain folders, **safely**.

## Decision

**A local host, paired with your account once, runs your agents in folders you
grant on the machine itself. The server can ask for a run; it can never choose a
folder, a command or a permission.**

### Pairing: once per machine, no token pasted

The host shows a short code, and **Connect** opens the browser at the instance's
`/pair` page, where the signed-in user confirms the code (the OAuth device flow
shape, RFC 8628). The host receives a **device token**, which is user-scoped,
sealed at rest on the machine, and revocable from the web (*Your devices*). This
is the one setup step allowed to take longer than five clicks, and it happens
once per machine.

### Grants: folders are chosen on the machine, never from the server

In the host's own window, the user grants folders and picks a **policy** for each:

| Policy | Means | Claude Code (**verified**, 2.1.289) | Codex (to verify) |
| --- | --- | --- | --- |
| **Read only** | Read files in this folder; change nothing | `--restricted --permission-mode dontAsk --permission-prompts none --strict-mcp-config --tools Read,Glob,Grep` | `--sandbox read-only` |
| **Edit in folder** (default) | Read and edit files in this folder; run no commands, no web | `--restricted --permission-mode acceptEdits --permission-prompts none --strict-mcp-config --tools Read,Glob,Grep,Edit,Write` | `--sandbox workspace-write` |
| **Full** | Commands, network, anything the tool can do | `--dangerously-skip-permissions` (today's behaviour) | `--approve-for-me` with `danger-full-access` |

Every policy also passes the session's MCP config with only Fabrikka's tools
allowed (`--mcp-config … --allowedTools mcp__fabrikka__*`). A policy governs
**the machine**: files, commands, network. What the agent may do in the session
is governed where it always was: trust tiers and grants (ADR 0010, 0014).

- A grant has an opaque id and a label the user picks (default: the folder's
  name). The server learns the id and the label, **never the path**.
- *Full* is opt-in per folder, behind a warning the host shows in plain words.
- The host refuses to grant a home directory, a filesystem root, or a folder that
  contains one of them (`~`, `/`, `C:\`). A grant is a project, not a machine.

### Runs: the server sends a request, the host builds the command

- On the web, **Add my agent** binds a session agent to *(this device, grant #2)*.
  The server stores the binding: device, grant id and the label for display.
- A mention that passes the delivery gate (ADR 0010, unchanged) becomes a **run
  request** to that device: session, agent, grant id and the triggering message.
  It never contains a path, a command line, a flag or a policy.
- The host looks up the grant **locally**, takes the policy **from its own
  config**, and builds the command from fixed templates for agent tools already
  installed on the machine. It never installs, updates or configures them, which
  is ADR 0002 unchanged. A request naming an unknown grant, or a grant revoked
  locally, is refused and reported back.
- Each run gets a short-lived run token (ADR 0011's run tokens), minted per run
  and revoked when it ends, exactly as the CLI runner does today.
- Concurrency is ADR 0011's: one run at a time per agent, a capped queue, and
  extra mentions dropped with a note.

### Seeing and stopping

- The tray icon shows when a run is active. A local log keeps every run: which
  session, which folder, which policy, how long it took, and how it ended.
- **Stop all** in the host ends every run at once. The session kill switch (ADR
  0012) still works from the web too.
- Revoking the device on the web disconnects it at once, and its bindings show
  as *offline* in their sessions.

### What the policies do and don't protect against

The policies are **enforced by the agent tool itself** (Claude Code's restricted
mode, Codex's sandbox), not by an operating-system sandbox.

- **They protect against** an agent being talked into acting outside its folder,
  or into running commands, by prompt injection from someone in the session
  (security.md, Threat 1). The tool refuses, whatever the agent was persuaded of.
- **They don't protect against** a malicious agent binary. The binary is the
  user's own install, and trusting it is the user's call, as it is today.
- An OS-level sandbox (macOS seatbelt, Linux namespaces) would be a stronger
  floor, and can be added under the same policy names later without changing
  this decision.

### Verified before building (2026-10-04)

`scripts/spikes/m31-policies.mjs` runs real headless `claude -p` runs in a
scratch folder and judges by the disk and the tool results, not by what the model
says. All 20 checks pass with the flags above. Three findings changed the design:

1. **`--restricted` alone still offers too much:** `WebSearch`, `Task`
   (sub-agents), `EnterWorktree`, `Skill`, `SendMessage` and more. So every
   policy names its tools exactly with `--tools`. Anything not listed doesn't exist.
2. **Without `--strict-mcp-config`, a restricted run loads the MCP connectors on
   the user's own Claude account.** The spike found claude.ai connectors in the
   tool list. An agent in a team session must never reach a member's personal
   connectors, so every policy is strict and loads Fabrikka's tools only.
3. **Plan mode refuses the Fabrikka tools,** so a read-only agent couldn't post
   its answer. *Read only* uses `dontAsk` instead: the exact tool list already
   removes every tool that writes.

Also confirmed: a headless run with prompts set to `none` finishes rather than
hanging; reads, writes and listings outside the folder are refused, including
through a symlink inside it; shell and web aren't available.

**Codex is not verified.** Only the Codex desktop app is installed here, not the
`codex` CLI that headless runs use. Until it is verified, Codex offers no
policies on the host. Rather than run unsandboxed, a Codex agent can't be bound
to a host folder.

## Consequences

- Adding your agent to a session becomes **Add my agent → folder → Add**, three
  clicks, with nothing to copy. Pairing and granting folders happen once.
- Today's default for Claude Code goes from no sandbox to *Edit in folder*, so
  most runs lose shell access. That's the point, and the one real cost: an agent
  that needs to run tests needs a folder granted *Full*.
- The server gains a **device** concept: devices, pairing codes and bindings.
  It holds no paths and no policies, so a database leak reveals folder labels,
  not a filesystem.
- The host is a long-lived process on the user's machine. It reuses the bridge
  socket's reconnect-with-backoff (ADR 0011). It ships as a mode of the bridge
  package (`fabrikka host`), with the desktop app (M9) giving it a tray and a
  window. Packaging is settled in the milestone.
- The CLI runner (`fabrikka watch`) stays for servers and scripts, with the same
  three policies as flags. Its default also becomes *Edit in folder*.

## Alternatives considered

**Keep the CLI runner and generate a nicer command.** It's least work. Rejected:
it's still a paste per session, which fails the five-click rule, and the process
still dies with its terminal.

**Let the server choose the folder, from a path the user types on the web.** It's
fewer screens. Rejected: the server, or anyone who compromises it, could then point
an agent at any folder on the machine. The grant has to be made where the files
are.

**One grant for the whole machine (or the home directory).** It's simplest.
Rejected: it makes every project, and every secret on the disk, reachable by every
mention. A grant is a project.

**An OS-level sandbox first.** It's the strongest isolation. Deferred, not
rejected: it differs per operating system and is real work on each. The policy
names are chosen so a stronger floor can be added beneath them later.

**Hosted agents (Fabrikka runs them for you).** That would need no local app at
all. Rejected here: it's the *Later* item in the roadmap, and only compatible with
ADR 0002 if the team runs the machine.
