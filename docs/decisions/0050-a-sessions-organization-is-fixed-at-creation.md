# 0050 — A session's organization is fixed at creation

**Status:** Proposed
**Date:** 2026-10-16
**Amends:** [ADR 0025](0025-teams-and-who-can-see-a-session.md) (a session
belongs optionally to one team) and the "a room changing organization" clauses
of [ADR 0043](0043-folders-and-personal-connections-belong-to-one-organization.md)
and M48. [ADR 0028](0028-team-credentials-are-shared-marked-and-lose-to-your-own.md)
mentions "the session moving out of the team" as one way access ends; that way
no longer exists, and the rest of it stands.

## Context

Since M21 a session's owner could move it between organizations, or out of
one, from the room's settings: a selector, a confirm, and three things
happened underneath. Members the old organization had granted were removed,
team visibility fell back to private, and every host running an agent in the
room was told to check its folders again (ADR 0043). The organization's shared
connections stopped applying on the next call.

The owner's rule, 2026-10-16: **the organization chosen at the top left is
the one everything assumes.** A session or chat started from the list is in
that organization; connections and folders are that organization's; People
and the organization's integrations are its. Under that rule a room never
needs to say which organization it is in, because it was created where you
were. A room that can *change* organization breaks it: it is the one place
that asks the question again, and the one event after which what the
switcher says and what a room is can disagree.

## Decision

**A session's organization is set when it is created and never changes.**

- The room's settings show the organization as a fact, not a control. There
  is no *Move* and no *No organization* option.
- The server has no endpoint for it. `PUT /api/o/:owner/s/:session/team` is
  gone, with the code that removed team-granted members, reset visibility and
  refreshed hosts on a move.
- A room in the wrong organization is **started again in the right one**: a
  new session, created with the organization selected. Export (M27) carries
  the conversation over if it matters. This is the same answer ADR 0043 gave
  for folders and connections: to move something, remove it and add it again.
- What still ends access the way a move used to: **leaving the organization**
  (M21), which removes what the organization granted, and archiving or
  deleting the room.
- The host protocol loses one trigger for a `bindings` frame ("one of its
  rooms changed organization"). The frame, its shape and its other triggers
  are unchanged; a host that handles it as before is correct.

## Consequences

- Fewer rules to hold in the head: a room's organization, who can be added
  from the roster, whose connections and folders apply, and who may read along
  are all decided once, at creation.
- Nothing can silently sever an agent from its folder, or a member from a
  room, by a change to the room itself.
- Someone who started a room in the wrong organization starts another. The
  sidebar's **+** is where they are, so that is one click plus a title.
- Four acceptance checks that used the move to set up a state now set it up
  directly or test the neighbouring rule instead; the M48 manual test loses
  its "move the room" step.

## Alternatives considered

**Keep the move, hide it better.** The owner's rule is that the switcher is
the only place an organization is chosen; a hidden move still contradicts it.

**Move to the selected organization only ("Move here").** Proposed and
declined on 2026-10-16: no moving at all.
