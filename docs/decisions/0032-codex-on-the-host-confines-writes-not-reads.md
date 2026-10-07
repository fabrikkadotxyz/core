# 0032 — Codex on the local host confines writes, not reads, and says so

**Status:** Proposed
**Date:** 2026-10-07
**Extends:** [ADR 0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md),
whose Codex column was marked "to verify". This records what verifying it found,
and what Fabrikka promises for Codex as a result.

## Context

ADR 0027 defines three folder policies and enforces them through the agent
tool's own controls:
- *Read only:* read files in this folder, change nothing.
- *Edit in folder:* read and edit files in this folder; no commands, no web.
- *Full:* anything the tool can do.

Claude Code was verified against all of them with real runs (M31). Codex wasn't
installed then, so the host refused it rather than run it unconfined.

`scripts/spikes/m35-codex-policies.mjs` runs real `codex exec` runs (codex-cli
0.160.1) in a scratch project under the home folder. It judges by the disk, the
command results and the session, never by what the model says. Six findings:

1. **Codex's file access is its shell.** It reads and edits files through shell
   commands; with the shell switched off it can do neither. So Codex can't
   match *Edit in folder*'s "no commands": commands are how it works.
2. **The sandbox confines writes, not reads.** Under `workspace-write`, a
   command wrote nothing outside the folder and reached no network, but
   `cat ../outside.txt` printed a secret from the home folder.
3. **Confining reads breaks Codex.** Any custom permission profile, even one
   denying only an unrelated folder, crashes every shell command (exit 134), in
   the folder too.
4. **The user's own MCP servers leak in.** This machine's Codex config enables
   `node_repl` and `cua_repl` (the ChatGPT app's computer-use tools). They run
   outside Codex's sandbox: `node_repl` evaluated JavaScript in a "restricted"
   run. `-c mcp_servers={}` doesn't remove them, because overrides merge into
   the config.
5. **A per-run Codex home fixes that.** `CODEX_HOME` set to an empty temporary
   folder holding only a link to the user's `auth.json` loads none of their
   MCP servers, plugins, hooks, skills or memories, and the run stays signed in
   as them.
6. **The session's tools need a narrow pre-approval.** Every MCP call needs
   approval, and with prompts off they're all refused, `post_message`
   included. `mcp_servers.fabrikka_session.default_tools_approval_mode="approve"`
   pre-approves Fabrikka's own tools and nothing else.

## Decision

**Codex is offered on the host in all three policies, enforced by its own
sandbox, and labelled with exactly what that sandbox does and doesn't do: it
changes only what the policy allows, but it can read files anywhere on the
computer.**

| Policy | Codex | Verified |
| --- | --- | --- |
| *Read only* | `-s read-only` | changes nothing, even inside the folder; reads it |
| *Edit in folder* | `-s workspace-write`, network off | edits in the folder; writes outside and network refused |
| *Full* | `--approve-for-me` (today's runner) | as before (ADR 0011) |

All three add `approval_policy="never"`, web search off, and Fabrikka's server
pre-approved.

*Read only* and *Edit in folder* also get:
- **an isolated per-run Codex home** (only `auth.json`, linked), deleted when
  the run ends;
- **Codex's own reach-outside features switched off:** `computer_use`,
  `browser_use`, `browser_use_external`, `in_app_browser`, `apps`, `plugins`
  and `remote_plugin`.

*Full* keeps the user's own Codex setup, as the runner always has.

- **Said where it's chosen.** When adding a Codex agent, the folder picker
  shows: *"Codex can read files anywhere on this computer. In Read only and
  Edit-in-folder folders it changes nothing outside the folder, has no network,
  and none of your other Codex tools."* Adding it takes a confirming tick. The
  Folders window and the host's page say the same next to the policies.
- **Claude Code's guarantees don't change.** The policy names stay; the
  difference is stated per agent tool, where the agent is added.

## Consequences

- Codex agents run from granted folders with no paste, like Claude agents:
  **Add my agent → Codex → confirm → Add**.
- A prompt-injected Codex agent in an *Edit in folder* folder could read a
  secret elsewhere on the machine and post it into the session: its tools work,
  and reading isn't confined. That's the cost the label exists to state. It's
  why *Full* and *Edit in folder* aren't the same thing even for Codex, and why
  the delivery gate (ADR 0010) still decides who can mention it at all.
- The isolation is load-bearing: without it, a restricted Codex run could drive
  the computer through the user's own MCP servers. The acceptance check asserts
  the user's servers are absent.
- When a Codex version can confine reads without breaking its shell, the label
  goes away, through a new ADR that supersedes this one.

## Alternatives considered

**Only offer Codex in *Full* folders.** No new, weaker promise. Rejected (by the
owner, 2026-10-07): it gives up confinement that *does* hold, of writes, network
and other tools, and leaves Codex unusable in the folders people most want to
keep safe.

**Keep Codex off the host** until reads can be confined. The strictest. Rejected
for the same reason: the paste-per-session runner it leaves people with has the
same read exposure and fewer of the other controls.

**Deny specific folders** (`~/.ssh`, `~/.aws`, `~/.fabrikka`) with a permission
profile. Would narrow the exposure. Not possible today: any custom profile
crashes Codex's shell (finding 3).
