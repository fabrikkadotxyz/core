# 0051 — Every session belongs to an organization, and an account has its own

**Status:** Proposed
**Date:** 2026-10-16
**Amends:** [ADR 0025](0025-teams-and-who-can-see-a-session.md) (a session
belongs *optionally* to one team) and [ADR 0043](0043-folders-and-personal-connections-belong-to-one-organization.md)
(the *Personal* scope for folders). Follows [ADR 0050](0050-a-sessions-organization-is-fixed-at-creation.md).

## Context

Since M21 a session could be in no organization. Those were the *Personal
sessions*: shown under whichever organization the switcher had, created with
the **+** beside that heading, and, since 2026-10-16, able to use only the
*Personal* folders on a machine. The switcher's rule (ADR 0050: the
organization chosen is the one everything assumes) had one exception left,
and it was the whole Personal section.

The owner, 2026-10-16: *personal sessions' new name is individual sessions,
and individual sessions will be scoped to an organization as well.* Two
questions followed, and the owner chose:

1. An account with no organization, and the sessions that exist today with
   none: **each account gets its own organization**.
2. What makes a session *individual* inside an organization: **only you are
   in it**.

## Decision

**1. Every session is in an organization.** `sessions.team_id` is required
for sessions and chats; only a direct message between two people (ADR 0026)
is in none, because it belongs to the pair and not to either's organization.
Creating a session names the organization; the API's default, when none is
named, is the caller's own.

**2. An account has its own organization, named "Self"** (amended
2026-10-16: it was named after the person at first; the owner chose *Self*,
one word that says what it is in the switcher of every account). It is
marked as the account's own (`teams.own_of_user_id`), its person cannot
leave it or be removed from it, so the account is never without one, and it
is renamable like any organization. **Inside Self there is no distinction
between personal and organization integrations:** the Integrations place
shows one list, your own connections, and Self has no shared connections of
its own. Self has no *#general* either: a chat with yourself is not a chat.
Sessions, folders and the People page work as in any organization.

Existing accounts get theirs in the migration, and their sessions in no
organization move into it. Nobody gains access by this: the own organization
has one member, and the moved sessions keep their members, guests and
`private` visibility.

**3. Individual sessions are derived, not declared.** A session is
*individual* when it is private and nobody else is in it: one member, no
guest, `visibility = 'private'`. Everything else in the organization is an
*organization session*: one the organization can read along (`team`
visibility), or one with more than one person in it. The sidebar's
**Organization sessions** and **Individual sessions** are those two lists for
the chosen organization. The **+** beside *Individual sessions* starts a
private session there; the **+** beside *Organization sessions* starts one the
organization can read along from the start, so a new organization session
appears where it was started.

An individual session becomes an organization session the moment someone
else is let in or the organization is allowed to read along. That is what
the words mean; no column records it.

**4. The *Personal* folder scope is retired.** A folder is granted *for* an
organization, the own one included. The Folders window no longer offers
*Personal*; a folder granted that way earlier is listed as *Personal · no
longer used* and serves no room, until it is removed and granted for an
organization. Connections keep *all your rooms* (ADR 0043, amended
2026-10-14): that scope means every organization, which is still a meaning.

**5. The host protocol is unchanged in shape.** A `grants` frame may still
carry `org: null`; the server stores it and no room matches it. A binding's
`session.org` is never null for a session any more. Older hosts need no
change.

## Consequences

- "Where does this go?" has one answer everywhere: the organization at the
  top left. The sidebar, the folders offered, the connections offered, the
  People page and the integrations page all agree, with no Personal
  exception.
- A fresh account can start a session at once, in *Self*, with no *create
  an organization first* step. A deployment's sign-up that asks for
  an organization name makes that organization beside Self, not instead of it. Getting started's *Invite*
  always has an organization to invite into.
- The switcher lists the own organization first, then the others by name.
- **An organization's rooms go with it when it is deleted.** Until now
  `sessions.team_id` was set to null on deletion, which made the rooms
  personal; a room in no organization no longer exists, so the reference
  cascades. Nothing in the product deletes an organization today; an
  operator who does so at the database deletes its rooms with it.
- The migration creates one organization per existing account. For a person
  on an instance who already made an organization of their own for this
  purpose, that is one more entry in the switcher; they can rename it or
  move their work. The owner accepted this.
- Thirty-odd acceptance checks create sessions without naming an
  organization; the API's default keeps them meaningful, and each now
  exercises the own organization.
- The M48 check's *personal room* becomes a room in the own organization,
  with a folder granted for it.

## Alternatives considered

**Require creating or joining an organization before any session.** A
first-run step that most people would answer with their own name. Making the
organization for them is the same outcome without the step.

**A declared kind, individual or organization, chosen at creation.** It
would let a shared session stay listed as individual. The owner chose the
derived meaning: individual is *only you*.

**Keep no-organization sessions as a legacy state.** They would be the one
place the switcher's rule fails, which is what this decides against.
