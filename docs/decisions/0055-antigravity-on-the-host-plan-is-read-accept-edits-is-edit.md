# 0055 — Antigravity on the local host: plan is Read only, accept-edits is Edit in folder, and the session's tools come only with Full

**Status:** Proposed
**Date:** 2026-10-16
**Extends:** [ADR 0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md)
(the folder policies) the way [ADR 0032](0032-codex-on-the-host-confines-writes-not-reads.md)
and [ADR 0047](0047-opencode-on-the-host-is-confined-by-a-per-run-config.md)
did. Slot 1 of M16. Uses [ADR 0054](0054-agents-report-and-fabrikka-supervises-nothing.md)'s
variables for the session's tools.

## Context

M16 ranks Antigravity CLI (`agy`) first among the agents worth a spawn
adapter, and says to verify before building. The 2026-10-15 attempt stalled:
MCP servers live only in the user's config, and a probe under a throwaway
home signed the owner out. Today's findings, agy 1.3.5, from real runs under
the owner's real home in scratch folders, judged by the disk and the event
stream, never by what the model says (`scripts/spikes/m16-antigravity-policies.mjs`):

1. **Headless mode is complete.** `agy -p "<prompt>" --output-format
   stream-json` prints one JSON event per line: `init` (with the
   `conversation_id`, the tools and the `permission_mode`), `step_update`
   per step (`step_type` `user_input`, `tool` with `tool_name` and
   `tool_info.parameters`, `agent_response` with `text_delta`), and `result`
   with `status`, `response` and the `conversation_id`. `--conversation <id>`
   resumes one. `--disable-slash-commands` keeps a prompt from expanding a
   skill.
2. **`--mode plan` is Read only.** The model called `replace_file_content`
   and the file did not change; a shell command was denied; a read one level
   above the folder was denied. Reads are confined.
3. **`--mode accept-edits` is Edit in folder.** The typo was fixed; a shell
   command was denied (*denied* in the stream, no file written); a read and a
   write one level above the folder were denied.
4. **`--dangerously-skip-permissions` is Full.** A shell command ran.
5. **MCP servers are user-level only** (`~/.gemini/config/mcp_config.json`,
   `agy mcp add`), and an `http` server's headers are literal: no
   substitution from the environment. There is no per-run config.
6. **A user-level stdio MCP server inherits the run's environment.** A probe
   server added once with `agy mcp add -- name node server.mjs` received the
   variables the run was started with, on every run. That is the per-run
   binding this ADR needed: the entry is fixed, the room is not.
7. **In headless mode, `call_mcp_tool` is denied under `plan` and
   `accept-edits`**, and allowed under `--dangerously-skip-permissions`. No
   way to pre-grant it was found in 1.3.5: no permissions file, no
   allow-list flag, no custom agents on this machine.

## Decision

**Antigravity is offered on the host in all three policies, enforced by its
own modes. The session's tools reach it only in Full folders, through one
user-level stdio entry, `fabrikka connect`, that takes the room and the run
token from the environment. In Read only and Edit in folder the runner posts
its answer for it, as it does for any run that posts nothing.**

| Policy | Flags | Verified | Session's tools |
| --- | --- | --- | --- |
| *Read only* | `--mode plan` | the typo stays; a command is refused; a read outside the folder is refused | no: the runner posts the answer |
| *Edit in folder* | `--mode accept-edits` | the typo is fixed; a command is refused; a read and a write outside the folder are refused | no: the runner posts the answer |
| *Full* | `--dangerously-skip-permissions` | a command ran | yes, through `fabrikka connect` |

Every run: `agy -p "<preamble>\n\n<prompt>" --output-format stream-json
--disable-slash-commands`, plus `--conversation <id>` when continuing, in the
folder, with `FABRIKKA_URL` and `FABRIKKA_TOKEN` (the run token) in the
environment so the user-level `fabrikka` entry, if present, reaches this
room, and ADR 0054's three variables so it may report.

- **One-time setup, shown in Setup → Agents and on the picker's caveat:**
  `agy mcp add -- fabrikka fabrikka connect`. The entry names no room and
  holds no token: both arrive in the environment per run. It is the person's
  config, written by the person, once (ADR 0002).
- **The caveat on the picker** says what Full is for: *In Read only and
  Edit in folder, Antigravity cannot use the session's tools; its answer is
  posted for it. Full gives it the tools, after `agy mcp add -- fabrikka
  fabrikka connect` once.*
- **Activity** is read from `tool` steps on their first appearance
  (`state: ACTIVE`): `view_file`, `replace_file_content`, `write_to_file`,
  `multi_replace_file_content`, `sed_file` give a path; `run_command` the
  first word; `grep_search` and `find_by_name` the pattern; `read_url_content`
  and `search_web` the address or query; `call_mcp_tool` and the rest, the
  name only. `tool_info.output` is never read (ADR 0015).
- **Resume** uses `--conversation`; the policy is a flag, and a resumed run
  takes the same flags, so steering (M15) can use it.
- **The model is the user's own** (`--model`, not passed until M16's
  pass-through lands).

## Consequences

- An Antigravity agent runs from a granted folder with no paste: **Add my
  agent → folder → Antigravity → Add**, with the caveat's tick, as Codex.
- Read only and Edit in folder are confined for reads as well as writes,
  which Codex is not; the caveat is about the session's tools, not about the
  folder.
- A Full run can read the session and post itself; a confined run answers
  through the runner's relay, which every adapter has had since M5.
- If a later agy lets a permission be granted ahead for `call_mcp_tool`, the
  caveat goes and nothing else moves.
- The spike adds and removes one probe MCP entry in the user's config, says
  so, and leaves nothing behind.

## Alternatives considered

**An `http` entry per room** (`agy mcp add --header … fabrikka <room url>`).
Works for one room only and holds a long-lived token in the user's config.
Kept as the *Any MCP client* lane's command, for a person who wants exactly
that; not the adapter's path.

**A throwaway home per run.** Signs the owner out (2026-10-15). Never again.

**Full only.** Rejected for the reason ADR 0032 gave: plan and accept-edits
confine, and confinement that holds is worth offering.
