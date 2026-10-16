# 0043 — A folder, and a personal connection, belongs to one organization

**Status:** Proposed
**Date:** 2026-10-13
**Builds on:** [ADR 0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md)
(folders are granted on the machine), [ADR 0004](0004-per-participant-credentials.md)
(per-participant credentials), [ADR 0028](0028-team-credentials-are-shared-marked-and-lose-to-your-own.md)
(organization credentials), [ADR 0042](0042-people-see-organization-the-code-says-team.md)
(an organization is a `team` in the code).

## Context

People belong to several organizations: an employer, a client, a side
project. Today a folder granted on your computer can be bound in any room
you're in, and a personal connection (your GitHub) can be attached to any
room. Nothing stops your employer's repo, or your employer's GitHub token,
from being used in a client's room by a slip of the picker. And you can't
have one GitHub account for the employer and another for the client: a
person has one connection per vendor (`mcp_servers (owner_id, slug)`).

The owner's decision (2026-10-13): **a folder's configuration belongs to one
organization; with two organizations, you add the folder twice. The same for
a personal connection.**

## Decision

### The scope

Every folder grant and every personal connection has a **scope**: one
organization, or **Personal** (rooms outside any organization). A room
offers, and the server accepts, only what's scoped to the room's
organization (or Personal, for a room in none). A scope never changes; to
move something, remove it and add it again.

### Folders: chosen on the machine, as before

- **The Folders window asks "For"** when a folder is added: *Personal*, or
  one of your organizations. The same path may be added once per scope, with
  its own policy (read, edit, full): your employer's repo can be *edit* there
  and *read* for a client.
- **The host learns your organizations from the server** over its existing
  socket: a new frame `{ type: 'organizations', organizations: [{ id, name }] }`,
  sent on connect and whenever your memberships change. It's a label list
  for the picker; the machine stores the chosen id on the grant
  (`host.json`: `Grant.org`, null for Personal).
- **The host reports it:** the `grants` frame gains `org` per grant. The
  server stores it (`device_grants.team_id`), and ignores a grant scoped to
  an organization you're not in (as if it weren't sent).
- **Both ways (amended 2026-10-16, the owner's decision, reversing the one-way
  rule of 2026-10-13): a room uses the folders of its own scope and no other.**
  An organization's room, that organization's folders; a room in no
  organization, the *Personal* folders. The one-way rule let a personal room
  reach every organization's folder, and the owner saw other organizations'
  folders offered in a room where they were not working for them. The rule
  the owner stated: the organization chosen is the one everything assumes
  (ADR 0050), and a room in none assumes Personal.
- **"Add my agent"** lists what the room may use: that organization's folders,
  or the Personal ones in a room in no organization. `bindAgent` refuses the
  rest: *"this folder is for <org>, not this room"*.
- **The machine checks too.** A binding now says its room's scope
  (`session.org`). The host refuses to start a run in an organization's room
  whose grant is scoped elsewhere. The server can't steer a folder into another organization's
  room, even by mistake.
- **Leaving an organization** drops its grants on the server (as if not
  sent) and the bindings that use them, at the next `grants` frame; the
  folder stays on your machine, unusable, until you remove it.

### Personal connections: chosen on the Integrations page

> **Amended 2026-10-14, the owner's decision:** a Personal connection works in
> **all your rooms**. See the amendment at the end; the bullets below describe
> the first version where they differ.

- **`mcp_servers` gains `team_id`** (null for Personal). Unique becomes
  `(owner_id, team_id, slug)`, NULLS NOT DISTINCT: one connection per vendor
  **per scope**. Two GitHub accounts for two organizations is two rows.
- **The Integrations page has a "For" picker** (Personal, or one of your
  organizations), defaulting to the organization chosen in the sidebar. The
  list, Connect/Reconnect and Remove act on that scope. The OAuth flow
  carries the scope from start to callback.
- **A room attaches only connections in its scope,** and only those are
  resolved at run time (`serversForUser` filters by the room's scope).
- **"Your own wins" (ADR 0028) is per scope:** your connection in the room's
  organization beats the organization's shared one; a connection of yours
  for another organization never does.
- **Leaving an organization** stops its scoped connections from resolving
  anywhere; they're listed under that name as *no longer a member* to remove.
- **API:** `GET|POST /api/me/connections`, `DELETE /api/me/connections/:slug`,
  the catalogue and `POST /api/connections/oauth/start` take a scope:
  `?team=<id>` / `teamId` in the body, absent for Personal (ADR 0042: the
  code says *team*). Old clients that send none act on Personal.

### What exists today

Existing folders and connections become **Personal**. Rooms in an
organization that use them keep working until the next bind or attach: a
binding or attachment made before this ADR is honoured, and listed in the
room as *from Personal: add it for <org>* so it can be redone in the right
scope. New ones follow the rule.

## Consequences

- **A personal room cannot reach an organization's folder** (since
  2026-10-16; it could, between 2026-10-13 and then). Someone you've let into
  a personal room by link can never ask your agent about an organization's
  code: that happens in the organization's rooms, with its roster.
- Two organizations means adding a folder, and connecting a vendor, twice.
  That's the point: each is a decision about which organization gets what.
- The host protocol changes (`docs/protocol.md`): a new server frame, a new
  field on `grants` and on a binding's `session`. Older hosts don't send
  `org`; their grants are Personal, which is safe.
- `docs/data-model.md`: `device_grants.team_id`, `mcp_servers.team_id`.
- Organization credentials (ADR 0028) are unchanged.

## Alternatives considered

- **Choosing a folder's organization on the web page.** The server would
  decide which folders an organization's rooms get, which ADR 0027 keeps on
  the machine.
- **One grant, many organizations.** Fewer clicks, but the policy and the
  folder are shared across organizations, which is exactly what isn't wanted.
- **Leaving existing ones usable everywhere.** Keeps the slip this ADR is
  for.

## Amendment (2026-10-14): a Personal connection works in all your rooms

**Context.** The owner connected a vendor with the wrong organization selected
and couldn't attach it in a personal room. With two organizations every vendor
had to be connected twice. And the isolation was thinner than it looked: a
connection scoped to the client is the same account with the same reach at the
vendor, so the scope recorded intent, not capability.

**Decision.** A connection has one of two scopes:

- **All your rooms** (`team_id` null; the default when connecting): usable in
  your personal rooms and in every organization's rooms you're in.
- **One organization only** (`team_id` set): usable in that organization's
  rooms, and nowhere else. This is how a person keeps a second account for one
  organization, or keeps a work account out of a client's rooms.

In an organization's room, resolution order is: your connection for that
organization, then your connection for all your rooms, then the
organization's shared one (ADR 0028's "your own wins" holds). A room in no
organization uses only connections for all your rooms.

The question moves to connect time: *Use in: all your rooms* (default) or
*only <organization>*. The Personal integrations tab lists every connection
with its scope, instead of one scope at a time.

**Folders are unchanged.** A folder is an organization's code on your disk and
the machine enforces its scope; a connection is your identity at a vendor. The
asymmetry is deliberate.

**Consequences.**

- The employer-in-a-client's-room slip is possible again for anyone who
  connects a work account for all rooms. The defence is the choice at connect
  time, and it is one click.
- No migration: every existing connection is already in the all-rooms scope,
  so it works everywhere at once. `session_mcp_servers.from_personal` is no
  longer read; the *from Personal: add it for <org>* marker on attachments
  goes. Folder bindings keep theirs.
- `GET /api/me/connections` without `team` returns all of yours; with
  `?team=` exactly that organization's (the catalogue's *connected* is still
  per scope, so a second account can be connected for one organization).
- A room's *attach* offers your all-rooms connections and, in an
  organization's room, that organization's, one per vendor with the
  organization's winning.
