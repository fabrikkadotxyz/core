# 0018 — The session screen is three panes: configure, converse, produce

**Status:** Accepted
**Date:** 2026-09-29

## Context

The session screen was never designed. It accumulated.

M0 put a timeline next to a participants list. Every milestone since added a panel
to the same right-hand column: members (M1), agents and tokens (M3), invites (M1),
context and artifacts (M7), integrations (M8), a pause banner (M6), steps in the
timeline (M10). Nine panels, stacked, in a fixed-width `<aside>`, with the
conversation — the reason anyone opens a session — occupying less than half the
width.

Three specific costs, all observable in the current build:

- **Finding anything requires scrolling a column that mixes unrelated things.**
  "Copy my agent's token" and "what did we decide" are the same gesture in the same
  place, and neither is where you look.
- **The conversation is the narrow half.** Live activity landed at M10, so the
  middle column now has more to show per run than it did, in less room than the
  panels get.
- **Setup is permanent furniture for a one-time job.** You add an agent once and
  then talk for an hour, but the form stays on screen for the whole hour.

There is also a latent product question. The multiplayer thesis says a session is
where work gets *produced*, not just discussed — and the artefacts of production
(the objective, the decisions, the files) are currently buried between an invite
form and a token list, as though they were configuration.

## Decision

**Three panes, each answering one question, and the middle one is the product.**

| Pane | Question it answers | Holds | Collapses |
| --- | --- | --- | --- |
| Left — **Setup** | Who and what is in this session? | Participants, members, invites, agents, integrations, tokens, settings | Yes |
| Middle — **Conversation** | What are we saying? | Timeline, live activity, composer | **Never** |
| Right — **Output** | What has this session produced? | Session context and artifacts | Yes |

The rule that decides where a thing goes: **left changes the session, right is
changed by the session, middle is the session happening.** Adding an agent is
setup. A decision the group reached is output. A message is neither.

### The middle pane never collapses

Both side panes can close; the conversation cannot. A layout where every pane is
optional has no centre, and the one thing this product cannot be is a shell around
panels. Closing a side pane gives its width to the conversation.

Collapsed state is remembered **per session** in `localStorage`, not on the server:
it is a per-viewer, per-device preference, and a member who collapses the rail on
their laptop has said nothing about their phone. It must also survive being absent
— cleared storage renders the default, never an error.

### The right pane holds what exists, not what is coming

The original sketch for this pane was "what we want to generate with AI". That is
the right *intent* and the wrong *content* for today: we have no generation feature,
and a pane reserved for one would ship as an empty box with a disabled button.

So the pane holds **what the session has actually produced** — the context (objective,
facts, decisions, questions, constraints) and the artifacts, both real since M7. Both
are already written by agents through MCP, which means the pane is genuinely filled
by AI today; it is just filled by agents posting `update_session_context` rather than
by a button. When a generation feature arrives it has a home with an established
meaning, and users have not spent a month learning to ignore that third of the screen.

### It is a restyle, not a feature

No new endpoints, no schema change, no protocol change. One behavioural fix comes
along for free because the restyle surfaces it: **the Agents panel was gated on
`isOwner` in the web app** even though the server has allowed any member to add
their own agent since M3 (`apps/server/src/index.ts`, "ANY member may add their OWN
agent"). A member could not create `@claude-alice` through the interface — which is
half the multi-participant story ([ADR 0004](0004-per-participant-credentials.md)).

## Consequences

- Three panes need more horizontal room than two. Below ~1100px the side panes
  become overlays; below ~700px everything stacks with the conversation first. A
  phone shows the conversation and reaches setup deliberately.
- Panels move, so anyone who learned the old positions has to relearn them. Cheap
  now, expensive after there are users.
- The left rail mixes owner-only controls (invites, tokens, delete) with
  member-available ones (their own agents, their own integrations). Owner-only
  controls are **absent** for members, never present-but-failing — the same rule as
  everywhere else in this codebase: you do not see what is not yours.
- "Output" is a claim the product has to keep. If the right pane is still just
  context and artifacts in six months, the thesis is weaker than we said.
- Desktop (M9) is a webview over this same app, so it inherits the layout for free
  — and inherits the minimum window width too.

## Alternatives considered

**Tabs across the top.** One pane at a time, trivially responsive, no width
problem. Rejected: the point of a session is that the conversation and the work
are visible together. Tabs make watching an agent work while reading the objective
a navigation act.

**Keep two columns, reorder the panels.** Cheapest possible fix, and it addresses
the "can't find anything" complaint. Rejected: it leaves the conversation as the
narrow half and leaves the produced work classified as configuration, which is the
part that misrepresents what a session is.

**Collapsible middle, fully symmetric panes.** Maximum flexibility; a user who
wants a wall of panels can have one. Rejected: a product where the centre is
optional is a dashboard, and this is not one.

**Store collapsed state on the server, per user.** Follows you across devices.
Rejected as over-engineering a preference: it costs an endpoint, a table column and
a write on every toggle, to synchronise something a person re-decides in one click.

**Ship the right pane as a generation placeholder now.** Signals where the product
is going. Rejected: an empty pane with a disabled button trains people to ignore
that region, and it would be the most prominent thing in the UI making a promise we
have not built.
