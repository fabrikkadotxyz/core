# 0042 — People see "organization"; the code still says "team"

**Status:** Proposed
**Date:** 2026-10-13

## Context

What Fabrikka calls a *team* is the company or client a person works with:
the people they can add to a room without a link, its shared integrations
and its settings. People belong to several, one
per employer or client. The owner (2026-10-13) wants it called an
**organization**, and a person in one a **colleague** (formerly *teammate*).

"Team" is also part of surfaces other software depends on:
- the HTTP API (`/api/teams…`, a room's `…/team`, `visibility: 'team'`,
  an invite's `kind: 'team'`), used by the web and desktop apps;
- the kit (ADR 0029, 0041): `teamNotice`, `teamsOf`, `teamRole`,
  `onTeamMembersChanged`, `guardWrites({ teamId })`, used by deployments;
- the schema (`teams`, `team_members`, `team_mcp_servers`, …).

## Decision

**Everything a person reads says "organization"** (and "colleague"):
the web app, the server's error messages, tool descriptions agents read,
emails, and a deployment's own pages (such as its sign-up).

**Identifiers stay "team":** API paths and values, the kit, the schema, and
code names. Docs that describe those surfaces (`protocol.md`, `data-model.md`,
ADRs) keep "team" where they name an identifier, and may say "team" in
prose: in this codebase, *team* and *organization* are the same thing.

## Consequences

- Nothing breaks: no client, deployment or migration changes.
- The price is a translation in the reader's head: a page says
  *organization*, its route says `/teams/:id`. This ADR is where that's
  written down.
- A later full rename, if ever, is its own ADR, with API aliases and a kit
  deprecation period.

## Alternatives considered

- **Rename everything now.** Breaks deployments' kit calls and any
  desktop app in the field, for no gain to the person using it.
- **"Workspace".** Already means the sidebar's frame in the code (`WorkspaceProvider`),
  and suggests one per person rather than one per employer or client.
