# 0047 — OpenCode on the local host is confined by a per-run config, reads included

**Status:** Proposed
**Date:** 2026-10-15
**Extends:** [ADR 0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md)
(the folder policies) the way [ADR 0032](0032-codex-on-the-host-confines-writes-not-reads.md)
did for Codex. Slot 2 of M16.

## Context

ADR 0027 defines three folder policies, enforced by the agent tool's own
controls: *Read only*, *Edit in folder* (no commands, no web) and *Full*.
Claude Code was verified in M31, Codex in M35. M16 ranks OpenCode second among
the agents worth a spawn adapter, and says to verify before building.

`scripts/spikes/m16-opencode-policies.mjs` runs real `opencode run` runs
(opencode 1.18.35, 2026-10-15) in a scratch folder with a secret one level
above it, against a tiny MCP server that logs every request. It judges by the
disk, the server's log and the event stream, never by what the model says.
Ten findings:

1. **Headless mode is complete.** `opencode run --format json "<prompt>"`
   prints one JSON event per line: `step_start`, `tool_use`, `text`,
   `step_finish`, `error`. Every event carries the `sessionID`; `-s <id>`
   resumes it, and the resumed run remembers the earlier turn. `-m
   provider/model` picks the model. The model actually used is not in the
   stream; `opencode export <id>` records it (`providerID`, `modelID`).
2. **No sign-in is needed.** With no provider configured it runs on OpenCode's
   own free models (`opencode/*`). They are slow and uneven; one read-only run
   spent its whole time budget re-reading a file. A provider the user signed
   in to is chosen with `-m`.
3. **Config is layered and reachable from the environment.** `XDG_CONFIG_HOME`
   relocates the global config directory. `OPENCODE_CONFIG_CONTENT` is inline
   JSON applied above the project's own `opencode.json`. Values may say
   `{env:NAME}`, so the run token never touches a file or the command line.
4. **An MCP server from that inline config is reached in the run.** The
   server's log shows the bearer token from the environment on `initialize`,
   `tools/list` and `tools/call`, and the tool's answer came back in the text.
5. **Permissions are enforced by name.** `"*": "deny"` denies everything, MCP
   tools included; `read`, `glob`, `grep`, `list` and `fabrikka_session_*` set
   to `allow` re-admit exactly those. `tools: {"bash": false, …}` removes a tool
   outright: the model reports it has no shell. Under
   `external_directory: "deny"` a read one level above the folder fails and a
   write there is refused. **Reads are confined**, which Codex cannot do.
6. **A prompt that would ask is auto-rejected in headless mode:** *permission
   requested: external_directory (…); auto-rejecting*. A policy that forgets a
   key fails closed. `--auto` approves whatever is not denied: that is *Full*,
   and under it a shell command ran.
7. **Runs leave nothing in the folder.** Sessions go to OpenCode's own
   database under the user's data directory.
8. **A nonsense model fails at once**, exit 1, with an `error` event. The
   message is opaque (*Unexpected server error*), but the failure is visible.
9. **The user's own setup can be kept out.** `--pure` skips external plugins.
   With `XDG_CONFIG_HOME` pointed at an empty per-run directory, none of the
   user's global config loads: their MCP servers, agents and commands. A
   project's own `opencode.json` still loads, because it lives in the folder
   they granted; its MCP tools fall under `"*": "deny"` in *Read only* and
   *Edit in folder*.
10. **OpenCode takes its working directory from the inherited `PWD` variable,
    not from the process's real one.** A child started with `cwd` set but
    `PWD` left as the parent's listed, edited and ran commands in the parent's
    directory: the first acceptance runs wrote into this repository instead
    of the scratch project. `--dir <folder>` overrides it. The runner passes
    both `--dir` and `PWD`, and the spike records the finding so it stays
    verified.

## Decision

**OpenCode is offered on the host in all three policies, enforced by a
permission config Fabrikka passes to each run through the environment. Reads,
edits and commands are confined to what the policy says, so OpenCode needs no
caveat where it is chosen.**

| Policy | OpenCode config (inline, per run) | Verified |
| --- | --- | --- |
| *Read only* | tools `bash`, `edit`, `write`, `patch`, `webfetch`, `websearch`, `task` off; permission `*` deny, `read` `glob` `grep` `list` allow, `fabrikka_session_*` allow | the typo stays; a command is refused; a read outside the folder is refused; the session's tools work |
| *Edit in folder* | tools `bash`, `webfetch`, `websearch`, `task` off; permission as above plus `edit` allow, `external_directory` deny | the typo is fixed; a command is refused; a read and a write outside the folder are refused |
| *Full* | `--auto`, the user's own config | a command ran |

Every run: `opencode run --format json --pure --dir <folder>` with `PWD` set to
the folder as well (finding 10), the session's server as
`fabrikka_session` in `OPENCODE_CONFIG_CONTENT` with
`"Authorization": "Bearer {env:FABRIKKA_RUN_TOKEN}"`, and the preamble
prepended to the prompt. *Read only* and *Edit in folder* also set
`XDG_CONFIG_HOME` to an empty per-run directory, deleted when the run ends, so
none of the user's global OpenCode config loads. *Full* keeps the user's own
setup, as it does for Codex.

- **Resume works** (`-s`), unlike Codex: the policy is config, not a flag that
  a resume subcommand rejects. Steering (M15) can use it.
- **The server key is `fabrikka_session`**, as for Codex, so tools arrive as
  `fabrikka_session_post_message` and a project server named `fabrikka` is
  not merged with ours.
- **The model is the user's choice.** Nothing is passed until M16's model
  pass-through lands; OpenCode's own default applies, free models included.
  The setup hint says so.
- **No caveat.** Reads are confined, so the picker adds OpenCode in four
  clicks, with no tick.

## Consequences

- An OpenCode agent runs from a granted folder with no paste: **Add my agent →
  folder → OpenCode → Add**. It is named `opencode-<you>`.
- The enforcement is OpenCode's permission layer, not an operating-system
  sandbox. That is the same trust Claude Code's tool restrictions get (ADR
  0027). A bug in that layer widens the policy; the acceptance check judges
  by the disk so a regression shows.
- Free models make slow runs. The runner's ten-minute limit applies, and a
  slow model times out visibly rather than silently.
- The model used is reported only once M16's pass-through reads
  `opencode export`; until then the timeline shows no model for OpenCode.
- `--pure` and the empty config directory mean the user's OpenCode plugins
  and agents never run in a confined run. That is deliberate: a plugin runs
  outside the permission layer.

## Alternatives considered

**Write `opencode.json` into the granted folder.** The simplest injection.
Rejected: it leaves a token-bearing file in a repository that may be
committed, the mistake the Claude Code adapter avoids by writing its config to
a temporary directory.

**`opencode serve` plus `run --attach`.** Skips the MCP cold start per run.
Rejected: the bridge would start and supervise a long-lived OpenCode server,
which is owning the runtime (ADR 0002).

**`opencode mcp add` into the user's config.** Rejected: it configures the
user's own runtime, and the entry outlives the run.

**Only offer OpenCode in *Full* folders.** Rejected for the reason ADR 0032
gives: it gives up confinement that holds, and here it holds for reads too.
