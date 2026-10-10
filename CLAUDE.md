# Fabrikka — working agreements

**Start with [`PRINCIPLES.md`](PRINCIPLES.md)**: what the person using Fabrikka gets,
and the ground rules that settle an argument. Everything below is how we keep
those promises.

## Documentation first

**This project is documentation-first. Docs are written before the code they describe, and they are the source of truth.**

Concretely, for any change beyond a typo:

1. **Write or update the doc first.** A new capability starts life as a change to `docs/` — not as a commit that gets documented afterwards.
2. **Land the doc in the same change as the code.** A PR that changes behaviour without touching the relevant doc is incomplete.
3. **An architectural choice gets an ADR** in `docs/decisions/` before it is implemented. See `docs/decisions/README.md`.
4. **If code and docs disagree, the doc is the bug report.** Either the code is wrong, or the doc was never updated — resolve it, don't route around it.

Why this project in particular: Fabrikka's value is a *protocol surface* that external agents depend on. The MCP tools, the channel contract and the trust model are consumed by software we don't control, so they have to be specified before they're built or they become accidental APIs we can never change.

### Where things are documented

| Doc | Holds |
| --- | --- |
| `PRINCIPLES.md` | What the user gets, the current bet, the ground rules |
| `README.md` | What Fabrikka is, quickstart |
| `ARCHITECTURE.md` | The architectural rule, layers, hybrid wake-up design |
| `docs/protocol.md` | **The contract external agents depend on** — MCP tools, channel notifications, spawn invocations |
| `docs/security.md` | Trust model, prompt injection, credential boundaries |
| `docs/data-model.md` | Schema and what each table is for |
| `docs/operations.md` | Running an instance: bootstrap, admin CLI, invites, backups |
| `docs/themes.md` | **The contract theme authors depend on**: the pack format, the checks, the tokens |
| `docs/mvp.md` | The road to MVP: what's missing, in what order, and the acceptance stories |
| `docs/roadmap.md` | Milestones M0–M44 and their acceptance tests |
| `docs/decisions/` | ADRs — one per architectural decision, immutable once accepted |

Change `docs/protocol.md` with particular care: agents in the wild are bound to it.

## Five clicks, at most

**Every feature path is reachable in five clicks or fewer**, from wherever a person
would start it. Copying and pasting a command, a token or a URL counts as failing
the rule, not as one click: if a flow needs a paste every time, the flow is wrong.

- A milestone's manual test counts the clicks for its main path and says the
  number.
- One-time setup (signing in, pairing a machine) may take longer, but only once.
  It must never be repeated per session or per agent.

## The rule that overrides everything

> **Fabrikka does not own the agent. Fabrikka owns the session.**

The bridge is the sharp edge of this rule. It must never install, update or supervise an agent runtime — **the agent spawns the bridge, not the reverse.** See `ARCHITECTURE.md`.

## Conventions

- TypeScript throughout. pnpm workspaces. No package is added to the monorepo without a second consumer for it.
- The remote MCP endpoint uses **MCP SDK v2**; the bridge uses **v1**. This is deliberate and load-bearing — see `docs/decisions/0005-two-sdk-generations.md`.
- Milestones are sequential. Each has a manual acceptance test in `docs/roadmap.md`. Don't start the next one until the current one's test passes.

## Milestone workflow

Milestones are defined in `docs/roadmap.md` and are **sequential**. For each one:

1. **Docs first.** Update `docs/` (and an ADR, if the milestone makes an architectural choice) before writing code.
2. **Build it.**
3. **Run the milestone's manual test**, exactly as written in `docs/roadmap.md`. It is a gate, not a suggestion — do not start the next milestone until it passes.
4. **Add a scripted acceptance check** at `scripts/acceptance/m<N>.mjs` covering what can be checked without a human. It does not replace the manual test; it stops the previous milestone from silently regressing.
5. **Commit, one commit per milestone**, tagged `m<N>`. The commit message states what the milestone delivers and records that its test passed.

```bash
pnpm typecheck
pnpm test          # unit tests (pure logic)
pnpm acceptance    # every milestone's check, in order
git commit -m "M<N>: ..." && git tag m<N>
```

The checks run as a dedicated test account, `acceptance@example.com`, created on
first run by `scripts/acceptance/_setup.mjs`, never as a developer's own
account. Everything they create (teams, sessions, agents) lands there. Override
with `FABRIKKA_TEST_EMAIL` / `FABRIKKA_TEST_PASSWORD`.

Some checks are gated behind an env var because they cost a real model call.
Run them before tagging a milestone that touches their area:

```bash
FABRIKKA_TEST_SPAWN=1 node scripts/acceptance/m5.mjs   # spawns an actual claude -p
FABRIKKA_TEST_SPAWN=1 node scripts/acceptance/m6.mjs   # kills a real run mid-flight
FABRIKKA_TEST_SPAWN=1 node scripts/acceptance/m10.mjs  # asserts activity is live, not replayed
FABRIKKA_TEST_DOCKER=1 node scripts/acceptance/m39.mjs # builds the image, runs the self-hosted stack
FABRIKKA_TEST_DOCKER=1 node scripts/acceptance/m40.mjs # runs the image the way Render does
```

Run **every** existing acceptance check before committing a milestone, not just the current one.

**One exception to "sequential" (2026-10-10):** the hosting milestones (M39, M40)
are built in parallel with the feature milestones, because they don't change what
a room does. Feature milestones stay sequential. See `docs/mvp.md`, *Who does what*.

`docs/roadmap.md` also marks one hard ordering gate: **M6 (safety rails) must land before a second human is ever put in a session with a spawn-enabled agent.** See `docs/security.md`.
