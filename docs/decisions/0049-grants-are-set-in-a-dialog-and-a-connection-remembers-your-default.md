# 0049 — Grants are set in a dialog, and a connection remembers your default

**Status:** Proposed
**Date:** 2026-10-16
**Extends:** [ADR 0014](0014-aggregation-is-http-only-and-credentials-are-encrypted.md)
(grants are per tool, default-deny, a property of the session) and the M18
presets (*Read*, *Read & write*, a shortcut over those grants). M50's Tools
tab is where this lives.

## Context

What a session allows an integration to do is a list of tools with a
checkbox each (M8). GitHub's server offers about ninety; Atlassian's, forty.
Today the list opens *inside* the Tools tab, under everything else, when the
owner clicks *tools* on a connection's row: the rail scrolls, the list has no
filter, and it stays open. The owner named it on 2026-10-16, pasting the
GitHub list.

The second thing they asked for: the same choices are made again in every
room. A person who allows GitHub's read tools and `create_pull_request` in one
session wants that in the next, and said *maybe later we save with different
names*.

## Decision

**1. The grant list is a dialog.** Each attached connection's row has one
button, **Permissions**, which opens a modal over the room: the connection's
name, the sentence that nothing is permitted until allowed and that a grant
applies to everyone in the session, the M18 preset buttons where the entry
has presets, a filter box, then the tools, each with its checkbox and its
description. A count says *12 of 93 allowed*. A checkbox saves at once, as
today; *Done* closes. Non-owners open the same dialog and see the choices
with the boxes disabled, as today.

**2. A connection remembers your default.** The dialog's footer has **Save as
my default**, which stores the tools allowed right now, for that connection's
slug, under your account; and, once one exists, **Apply my default**, which
makes the session's grants for that slug exactly the saved set. The server
also applies it on its own in one case: **when you, as the room's owner,
attach a connection whose slug has no grant yet in that room**. Attaching as a
member applies nothing, because a member cannot set grants.

- The default is **yours**, not the room's and not the organization's: the
  session owner is the one who sets grants, and the default is their habit.
  It is keyed by `(user_id, server_slug, name)`. **One name today,
  `default`**; the key carries the name so that named sets (*review-only*,
  *release day*) come later without a migration or a new table.
- The default is a **list of tool names**, the ones allowed. Absent still
  means denied (ADR 0014), so applying a default is: allow these, deny the
  rest of that slug's rows in the session.
- A default never widens what a vendor offers: a tool in the list that the
  server no longer has is simply never called, and the dialog shows only what
  the server offers now.

**3. Nothing else changes.** Grants stay per tool, default-deny, keyed by
slug, set by the owner. The M18 presets stay a shortcut over them, now inside
the dialog. The MCP protocol is untouched: an agent sees exactly the tools
granted, as before.

## Consequences

- Granting a tool: **Setup → Tools → Permissions → the box**: 4 clicks.
  Saving the default is one more; applying it in the next room is 4; and
  when the owner attaches the connection, 0.
- The Tools tab no longer scrolls for a connection with many tools, and the
  room is visible behind the dialog, dimmed.
- A new table, `grant_defaults`, and three small endpoints under `/api/me`
  plus one under the session. `docs/data-model.md` has the shape.
- Named defaults are a UI change later: a name field beside *Save as my
  default*, and a list to apply from.

## Alternatives considered

**Defaults on the connection row (`mcp_servers`).** Rejected: a connection
can be the organization's (M30), never attached and owned by nobody in the
room, and a person may hold the same slug for several organizations (ADR
0043). The habit belongs to the person.

**Defaults per organization, set by its owners.** Useful later for a team
standard, but it is a policy, with a different question (who may loosen it?).
Not this.

**Apply the default on every attach, by anyone.** Rejected: a member would be
changing the session's grants, which only the owner may.
