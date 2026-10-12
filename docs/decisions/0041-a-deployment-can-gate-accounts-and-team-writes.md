# 0041 — A deployment can gate new accounts and a team's writes

**Status:** Proposed
**Date:** 2026-10-12
**Builds on:** [ADR 0029](0029-the-core-is-a-library-a-deployment-extends-it.md)
(the core is a library; a deployment extends it).

## Context

ADR 0029 lets a deployment add sign-up. A deployment that opens sign-up
also needs to say **"no"**: no more accounts (an operator's capacity cap), or
no more writing in a team (an organization the operator has suspended). It also
needs to **tell** people why, and to **know** when a team's size changes.

None of that can live in the deployment alone:

- **Accounts are created in two places in the core,** not only through the kit:
  sign-up through an invite (`/api/auth/signup`) creates one too. A cap that
  only guarded the kit would leak through invites.
- **Writes happen in the core:** messages, rooms, agent runs, uploads, from the
  web app and from agents over MCP.
- **The web app is the core's.** A deployment can serve its own pages, but it
  can't put a notice in front of someone already in a room.

What the core must not learn: a deployment's own rules for who may do what,
or any vendor. It offers places to say no and to explain, and the deployment
decides.

## Decision

**Four kit additions, all optional. A core with no extension behaves exactly
as before.**

### 1. `guardNewAccounts(check)`

`check({ accounts })` runs before **every** account the core creates, except an
operator's from the command line (`admin create-user`). That covers the kit's
`createAccountWithOwnTeam`, sign-up through an invite, and `/setup`.
`accounts` is how many exist.

- It returns `null` to allow, or a sentence to refuse with. The sentence is
  shown to the person.
- **Checked and created as one step:** a transaction under an advisory lock, so
  two sign-ups at the 99th account can't both become the 100th.
- Several checks may be registered; any refusal refuses.

### 2. `guardWrites(check)`

`check({ userId, teamId, ownerUserId, action })` runs before a write in a room
or a team. `teamId` is the room's team, or `null` for a room outside any team,
whose owner is `ownerUserId`. `action` is a short name (`message`, `room`,
`agent-run`, `upload`, `context`, `integration`, `invite`, …) for the log and
the deployment's own use.

- It returns `null` to allow, or `{ reason, url? }` to refuse. The core answers
  **402 Payment Required** with them, and the web app shows the reason and a
  link to `url`.
- **What it guards:**
  - in a room: sending messages, adding agents and starting their runs,
    uploading, editing context and links, outputs and their comments,
    integrations, invites;
  - in a team: creating rooms, team chats and invites;
  - over MCP: every tool that writes.
- **What it never guards,** so a gated team can still leave, clean up and take
  its data away: reading anything; marking read; notification settings;
  leaving a room or team; removing members, guests, agents, files, outputs or
  links; revoking invites and tokens; pausing agents; disconnecting
  integrations. Signing in and account settings are never guarded.
- Several checks may be registered; the first refusal wins.

### 3. `teamNotice(provide)`

`provide({ teamId, userId })` returns `null` or `{ text, url?, tone }`, where
`tone` is `info` or `attention`. The core adds it to that team in `GET
/api/teams`, and the web app shows it as a bar above the team's rooms: *"This
organization is read-only until its owner contacts support"*. Short text, no markup. A deployment decides who sees
what; the core shows what it's given.

### 4. `onTeamMembersChanged(listener)`

`listener({ teamId, members })` runs after someone joins or leaves a team,
including by invite, removal or leaving. `members` is the new count. It's
called after the change commits, never blocking it. A failing listener is
logged and doesn't undo anything.

Plus two small reads a deployment needs to act on these: `team(teamId)` (`{ id,
name, createdAt, members }` or null) and `teamRole(teamId, userId)` (`'owner' |
'member' | null`).

## Consequences

- **A deployment can cap accounts and suspend an organization's writes**
  without the core knowing its rules.
- **402 becomes part of the API.** `docs/protocol.md` lists it. Agents get it
  as a tool error with the reason, so an agent can tell its human why it
  stopped.
- **One more lookup per guarded write**, only when a check is registered.
- **Agents running on someone's computer keep running** when a team is gated;
  only their writes into the room are refused. That's the right boundary for a
  product that doesn't own the agent.

## Alternatives considered

- **A deployment's rules in the core.** Policy and vendors in a core that
  self-hosters don't need, and ADR 0029 says the opposite.
- **Gate at the proxy, by URL.** Writes come over MCP and WebSockets too, and a
  room's team isn't in its URL.
- **A policy table in the core.** A deployment's rules would become the core's
  schema. A check function keeps the decision with the deployment.
