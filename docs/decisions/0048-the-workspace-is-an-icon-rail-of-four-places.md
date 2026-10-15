# 0048 — The workspace is an icon rail of four places

**Status:** Proposed
**Date:** 2026-10-15
**Amends:** M28's sidebar (`docs/roadmap.md`) and its Settings screen of
2026-10-14. [ADR 0026](0026-chats-are-a-light-kind-of-session.md) (chats are
sessions) and [ADR 0018](0018-session-screen-is-three-panes.md) (a room's
three panes) are unchanged.

## Context

Every signed-in page sits beside one sidebar (M28). The sidebar grew by
accretion: an organization switcher, Home, *Organization chats*, *Organization
sessions* (five, then a link), *Direct messages*, *Personal sessions*, and at
the bottom Settings, the account and the licence link. Settings is one screen
of five tabs, two of which are integrations.

Three things are wrong with it, and the owner named them on 2026-10-15:

1. **Sessions and chats are different kinds of work** (ADR 0026: a session has
   output, agents and tools; a chat is a conversation) but they share one
   scrolling column, so neither gets room. Five sessions show; the rest are a
   click away.
2. **Integrations are a kind of place of their own**, not a settings tab. A
   person goes there to connect a tool and comes back; it is the second most
   visited screen after a room.
3. The column mixes **places** (where am I) with **things** (which room). Chat
   tools solved this long ago with an icon rail: a thin column of places at
   the far left, and beside it the list for the place you are in.

## Decision

**The shell is three columns: an icon rail of four places, the list for that
place, and the page.**

- **The rail** holds, top to bottom: the Fabrikka mark (Home), then
  **Sessions · Chats · Integrations · Settings**, each an icon with a short
  label, then the account at the bottom. It is fixed in width and never
  scrolls. Sessions and Chats carry the *needs you* number for the rooms of
  their kind (M42), and a dot when something is unread; the rail is where the
  M42 signal lives when the room is in another place.
- **The list** is the resizable column M36 built. It shows the organization
  switcher at the top, always, because every place is scoped to the chosen
  organization, then what belongs to the place:
  - *Sessions*: Home, then the organization's active sessions, all of them,
    most recent activity first, with **+** to start one and *All organization
    sessions* for archived ones and the filter; then *Personal sessions*.
  - *Chats*: the organization's chats and *Add a chat*; then *Direct messages*
    and *New message*.
  - *Integrations*: *Personal* and the organization's.
  - *Settings*: *People*, *Your devices*, *Appearance*; and, at the bottom,
    who you are, *Sign out* and the source link (ADR 0034).
- **The place follows the page.** A session opens under Sessions, a chat or a
  direct message under Chats, an integrations page under Integrations, a
  settings page under Settings. Clicking another place while a room is open
  **changes the list, not the page**: the room stays where it is until you
  pick something, which is how a chat tool behaves. From a settings or
  integrations page, Sessions and Chats take you home with that list shown.
- **Integrations get their own addresses:** `/integrations` (personal) and
  `/integrations/organization`. The settings tabs `/settings/integrations` and
  `/settings/organization` forward there, keeping the query, so the OAuth
  callback and every notice keep working. Settings keeps `/settings/people`,
  `/settings/devices` and `/settings/appearance`, and `/settings` opens the
  first one offered.
- **Nothing new is permitted.** The rail shows what the sidebar showed,
  arranged by place; the server changes only where its OAuth callback
  redirects.
- **On a phone** the rail and the list are one drawer, as the sidebar was.
- **Themes** paint the rail with the sidebar's own tokens (`--side-*`); no new
  token, so the theme contract (ADR 0038) is unchanged.

## Consequences

- A room's list is longer and of one kind. No "five, then a link".
- Integrations is one click from anywhere, instead of two (Settings → tab).
  Every path that went through Settings stays within five clicks; the
  *Getting started* card's links follow the new addresses.
- Home is the Fabrikka mark and the first entry under Sessions. It keeps what
  it had: *Waiting for you*, *Getting started*, organizations.
- Switching place while a room is open leaves the page alone. Someone who
  expects a click on *Chats* to open a chat gets the list of chats, one click
  from any of them.
- The rail costs about 56px of width. Under 900px it is in the drawer, so a
  phone loses nothing.

## Alternatives considered

**Keep one column, collapse the sections.** Cheaper, but it keeps places and
things in one list, and a collapsed section hides the M42 signal.

**Tabs at the top of the one column** (*Sessions | Chats*). Solves the first
problem only; Integrations and Settings stay at the bottom, and the switcher
loses its row.

**Rail items that navigate to a landing page each.** A *Chats* page listing
chats would need to exist, and clicking *Chats* would leave the room you are
in. Changing the list instead is what people know from chat tools, and needs
no new page.
