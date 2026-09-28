# 0003 — Hybrid wake-up: channels when live, spawn when away

**Status:** Accepted
**Date:** 2026-09-25

## Context

`@claude-fede investigate this` needs to reach an agent. It has no standard delivery mechanism.

**MCP is pull-only.** A server cannot make an idle agent act. Evidence:

- `sampling` — the one server→client primitive that could ask a client's model to generate — was **deprecated in MCP spec revision `2026-07-28`**, alongside Roots and Logging, with a 12-month offramp. New implementations are told to integrate with LLM provider APIs directly.
- Server-initiated events are Priority 1 on the August 2026 MCP roadmap, but have not shipped. The documented state of the art is client-side polling; the roadmap explicitly calls this "expensive client-side polling" it wants to end.
- The legacy HTTP+SSE transport is deprecated. The spec now emphasises **stateless HTTP**, which moves further away from held bidirectional streams, not toward them.
- `elicitation` asks the *human*, not the model, and MRTR is a response to an in-flight tool call — neither starts a turn.

**Claude Code has a proprietary escape hatch.** The `claude/channel` capability lets an MCP server push `notifications/claude/channel` into a live session; Claude reacts on its next turn and replies through a normal tool. Constraints: **stdio only**, research preview, third-party channels require `--dangerously-load-development-channels`, first-party Anthropic auth only (not Bedrock / Vertex / Foundry), blocked by default on Team and Enterprise.

**A runtime-owning approach doesn't need MCP push at all.** A daemon that installs and supervises agent CLIs can poll its own HTTP API for pending work every few seconds. On a mention it spawns `claude -p <prompt> --output-format stream-json --mcp-config …` (with `--resume` for continuity) or `codex exec [resume <id>] --json --full-auto`, and injects its own MCP server into the spawned agent via `--mcp-config`.

So there are two viable mechanisms, with opposite properties:

| | Channel push | Spawn per mention |
| --- | --- | --- |
| Reaches | A session already running | A fresh headless process |
| Agent has | Your repo open, your context, permissions intact | Empty context, no prompts possible |
| Vendors | Claude Code only | Claude Code and Codex both |
| Feels like | Collaboration, human present | Delegation, human away |
| Needs | Research-preview flag | `--dangerously-skip-permissions` |

## Decision

**Do both, chosen per mention by connection state.**

```
@mention arrives
  ├─ live bridge connection attached?  ──yes──>  claude/channel push
  └─ no ──────────────────────────────────────>  spawn headless run
```

Delivery is implemented in the bridge. Channel-specific code is isolated in a single module so a research-preview contract change is a one-file fix.

## Consequences

- Two delivery code paths to build and keep working.
- The good path depends on a research-preview feature behind a `--dangerously-` flag whose syntax may change. Contained by isolating it.
- The spawn path requires unattended execution (`--dangerously-skip-permissions` / `--full-auto`), which is only safe because of mention-gating and trust tiers. **ADR 0003 and `docs/security.md` are load-bearing for each other — never relax one without re-reading the other.**
  > *Note, 2026-09-28:* `--full-auto` was the flag at the time of writing and no
  > longer exists in codex-cli. The current invocations are in `docs/protocol.md`;
  > [ADR 0011](0011-spawning-is-local-and-opt-in.md) supersedes the spawn details.
  > The point about gating being load-bearing is unchanged.
- Codex always takes the spawn path; it never joins a live session. The success criterion's "five participants" is reachable, but Codex reaches it asynchronously. Say so honestly in demos.
- Bridge is pinned to MCP SDK v1 — see ADR 0005.

## Alternatives considered

**Remote HTTP only, pull-based.** Vendor-neutral, no CLI, no preview flags. Rejected: an idle agent never wakes, so participation only happens while the agent is already looping. Claude Code's 5-minute HTTP idle timeout also caps how long a long-poll can block. The product would not feel alive.

**Channels only.** Smallest surface, purest form of "don't own the runtime", best in-the-loop feel. Rejected: leaves Codex as a pull-only participant and offers nothing when the human is away — which is much of the value.

**Poll and spawn, no channels.** Full vendor parity day one, no preview flags, no Anthropic-auth restriction. Rejected: it never joins the session you already have open with your context loaded, which is the single most compelling thing this product can do.

**Own the runtime with a supervising daemon.** Install and supervise agent CLIs, get clean parity. Rejected by ADR 0002.
