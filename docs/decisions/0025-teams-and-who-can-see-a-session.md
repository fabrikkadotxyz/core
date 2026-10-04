# 0025 — Teams, and who can see a session

**Status:** Proposed
**Date:** 2026-10-03

## Context

Until now a session has had exactly two kinds of people: its members, who see
and do everything, and everyone else, who gets a 404. That is the whole access
model, and its simplicity is a feature. "Organizations" and "public sessions"
were on the roadmap's not-MVP list for that reason.

Four of the stories behind M18–M27 need more:

- **S2:** a team where every teammate can follow some sessions without being
  invited to each one.
- **S3, S4:** a team whose sessions are still private by default, where adding a
  teammate needs no invite link because the server already knows who they are.
- **S9, S12:** an advisor or a client who should read and comment on one session
  without being able to post or drive anyone's agent.

The risk is building an access-control system: roles, permission matrices, SSO,
inheritance rules. Each of those makes sense alone, and together they would turn
"who can see this?" into a question nobody can answer by looking. This ADR adds
the least that serves the stories.

## Decision

**A team is a list of people. A session can be seen by its members, by its
team (only if the owner says so), and by guests named one session at a time.
Nothing else.**

### Teams

- `teams` and `team_members(team_id, user_id, role: owner | member)`. Owners invite
  and remove members, and that is the only difference between the roles.
- People join a team through single-use invite links (M1, unchanged in
  mechanism). A team invite is a second way to create an account, and there's
  still no open signup.
- A session belongs to its creator and **optionally** to one team. Belonging to a
  team decides *who can be added from the roster*. It does not, by itself, make
  the session visible to anyone.

### Visibility and roles in a session

| Visibility | Who can see it |
| --- | --- |
| `private` (default) | Its members and its guests |
| `team` | Plus every member of its team, as viewers |

| Role in a session | Reads | Comments on outputs (M23) | Posts, mentions, drives agents | Sees Setup |
| --- | --- | --- | --- | --- |
| `owner`, `member` | ✓ | ✓ | ✓ (subject to trust tiers) | ✓ (owner-only controls as today) |
| **viewer** (from `team` visibility) | ✓ | ✓ | — | — |
| **guest** (invited to one session) | ✓ | ✓ | — | — |

- Viewer and guest are the **same capability** reached two ways. A viewer gets it
  by being on the team; a guest is named for one session and learns nothing
  else about the team.
- Viewers and guests **can't trigger an agent**. They can't post, so they can't
  mention, and delivery is gated at the source (ADR 0010).
- **Not "public".** That word is reserved for people outside the instance (ADR
  0022). A team-visible session is a 404 for anyone outside the team, and
  existence stays private (security.md).
- Access granted by a team ends when team membership ends. Access granted by a
  direct invite doesn't. Each grant remembers where it came from, so removing
  someone from a team removes exactly what the team gave them.

## Consequences

- "Who can see this session?" is answered by one field and two lists, shown in
  Setup. A reader can work it out without reading code.
- The access check becomes a function of membership, team visibility and guest
  grants. It replaces scattered `isMember` checks with one function used by the
  REST API, the session stream, output sockets and MCP. MCP is unaffected in
  practice: viewers and guests hold no participant tokens, so they have no MCP
  access.
- **New exposure:** a team-visible session shows its timeline, outputs and links
  to everyone on the team, including whatever an agent posted from someone's
  private repo. Making a session team-visible is therefore the owner's deliberate
  act, it's shown on the session, and `activity_visible` still applies.
  security.md gets a threat section before M22 is built.
- Teams have no billing, SSO, nested teams, per-team roles beyond owner/member,
  or cross-team sessions. Each of those would need its own ADR, and the stories
  don't ask for them.
- Existing sessions are unaffected: no team, `private`, the same members.

## Alternatives considered

**Organizations with workspaces, roles and policies**, the usual SaaS shape. It
anticipates enterprise needs. Rejected: none of the stories needs it, and it's
the complexity the not-MVP list kept out for good reason. When an enterprise asks,
they'll be specific about what they need.

**Team visibility by default.** It's more discoverable inside a team. Rejected:
sessions hold work from people's private repos and agents, and private by default
is the promise every earlier ADR assumes.

**Viewers as members with a flag.** It's one fewer concept. Rejected: a member
holds a participant identity, can be mentioned, can hold tokens, and appears in
`list_participants`. A viewer must have none of that, and a flag on a member row
is one forgotten check away from a viewer driving an agent.

**Public sessions (anyone with the link).** This is the literal reading of
"public". Rejected here: that's ADR 0022's territory (recaps), deliberately frozen
and consented to, never a live window.
