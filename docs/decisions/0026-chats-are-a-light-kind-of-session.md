# 0026 — Chats are a light kind of session

**Status:** Proposed
**Date:** 2026-10-04

## Context

The home (M28) is becoming a place a team lives in, like a chat tool, with team
chats and 1:1 direct chats beside sessions. A chat and a session feel different:

| | Session | Chat |
| --- | --- | --- |
| Purpose | One bounded problem | Ongoing conversation |
| Lifetime | Weeks, then archived | Indefinite |
| Members | Invited, one by one | The whole team, or exactly two people |
| Produces | Outputs, context, links | Messages |

But underneath, a chat needs almost everything a session already has: messages
with mention markers (ADR 0008), a live stream, presence, read positions (M24),
privacy that answers 404 to outsiders, and, because this product is about people
and agents together, the ability to mention an agent and have the delivery gate
decide whether it runs (ADR 0010).

## Decision

**A chat is a session with `kind = 'chat'` (a team chat) or `kind = 'direct'` (a
1:1 chat). It uses the same engine, shown lighter.**

- `sessions.kind`: `session` (the default, everything until now), `chat` or
  `direct`.
- **A team chat** belongs to a team, and **every team member is a member**,
  granted through the team (`session_members.via_team_id`, M21). Joining the
  team brings you in; leaving takes you out. Membership is materialized on
  access, so a teammate who has never opened a chat is still in it the moment
  they do.
- **A direct chat** has exactly two members and no team, and there is one per pair
  of people. You may start one only with someone you share a team with.
- **Shown lighter:** no output pane, and Setup shows only members and agents. The
  timeline, mentions, agents and delivery gate are the same code, so an agent
  mentioned in a chat obeys the same trust tiers as in a session.
- **Becoming a session** creates a new `session`-kind session whose context links
  back to the chat. The chat is not converted or copied, so its history stays
  where people wrote it.
- Every existing rule that keys on session membership (404 for outsiders,
  per-participant tokens, read positions) applies to chats unchanged, because a
  chat *is* a session.

## Consequences

- Chats get mentions, agents, presence, catch-up and privacy for free, and every
  later improvement to the timeline reaches both.
- `kind` becomes a branch in the UI (which panes to show) and in membership for
  team chats. The server's access rules don't branch on it.
- A team chat is an open room for the whole team, so posting there reaches
  everyone on the team, including later joiners reading its history. The UI says
  so on first post.
- Session-shaped features that make no sense for chats (outputs, templates,
  team visibility, export) are hidden for chats, not forbidden by the server. A
  chat that needs them should become a session.
- Agents' turn budget and kill switch (ADR 0012) are per session, so per chat.
  A runaway agent in *#general* halts *#general*, nothing else.

## Alternatives considered

**A separate messaging system for chats.** It's cleaner conceptually. Rejected:
it duplicates messages, mentions, streams, presence, privacy and read positions,
and agents couldn't be mentioned in chats without building the delivery path a
second time.

**Team chats as team-visible sessions (M22).** That machinery already exists.
Rejected: a team-visible session's teammates are *viewers* and can't post, and a
chat everyone can read but nobody can write in isn't a chat.

**Explicit chat membership (join/leave per chat).** It gives finer control.
Rejected for now: teams in this product are small and trusting (ADR 0025), and
derived membership means nobody is ever left out of *#general*. Private
sub-group chats can come later as ordinary sessions.
