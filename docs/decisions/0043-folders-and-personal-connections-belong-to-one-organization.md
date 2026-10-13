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
- **One way only (amended 2026-10-13, the owner's decision): a personal room
  may use any of your folders; an organization's room only that organization's.**
  Your personal rooms are your own workspace, and you're in every organization
  whose folders you hold. The other direction is what this ADR is for: no
  Personal folder, and no other organization's, in an organization's room.
- **"Add my agent"** lists what the room may use: in an organization's room,
  that organization's folders; in a personal room, all of yours, each marked
  with its organization. `bindAgent` refuses the rest: *"this folder is for
  <org>, not this room"*.
- **The machine checks too.** A binding now says its room's scope
  (`session.org`). The host refuses to start a run in an organization's room
  whose grant is scoped elsewhere. The server can't steer a folder into another organization's
  room, even by mistake.
- **Leaving an organization** drops its grants on the server (as if not
  sent) and the bindings that use them, at the next `grants` frame; the
  folder stays on your machine, unusable, until you remove it.

### Personal connections: chosen on the Integrations page

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

- **A personal room can reach an organization's folder.** Anyone you've let
  into that room (a link invitee, a guest) can ask your agent about that
  organization's code. Bringing an organization's folder into a personal room
  is the room owner's own call; an organization's rooms never get it.
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
