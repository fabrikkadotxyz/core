# 0028 — Team credentials: shared, marked as shared, and second to your own

**Status:** Accepted
**Date:** 2026-10-04
**Supersedes, for team credentials only:** [ADR 0004](0004-per-participant-credentials.md).
Every other credential stays per participant, exactly as 0004 says. This also
reverses the *team-level shared credentials* alternative that
[ADR 0024](0024-connections-are-categories-over-vendor-mcp-servers.md) rejected.

## Context

Since ADR 0004, every credential belongs to one person. A call routes to the
calling participant's own token, so the vendor's audit log names whoever acted.
That stays the right default.

Some connections are the team's, though, not any one person's: a Sentry org
token, a CI account, a shared docs workspace. Today the only way to use one is
for a person to paste the team's token in as if it were their own. Then every
call is attributed to that person, and only their agent can use it. Asking each
member to paste the same team token into every session also fails the
five-click rule.

ADR 0004 had two objections to shared credentials:

1. **Access is lent silently.** "I invited you to a room" became "I gave you my
   write tokens."
2. **Audit stops being honest.** Every action looks like one person's.

This ADR admits team credentials without bringing either problem back.

## Decision

**A team owner can add a credential that belongs to the team. Any team member,
and any agent whose owner is a member, can use it in that team's sessions,
unless they have attached their own credential for the same integration. Their
own always wins. A team credential is marked as shared wherever it appears, and
every call made with it is recorded with the participant who made it.**

### Who adds them

- **Only team owners** (`team_members.role = 'owner'`) can add, replace or remove
  a team credential, from **Team integrations** in the sidebar.
- Members can see that a team credential exists: its name, server, who added it
  and what it's for. They never see the secret. Like every credential, it is
  sealed under `FABRIKKA_ENCRYPTION_KEY`, refused without the key, and never
  returned by any API (ADR 0014).

### Where they apply, and to whom

- A team credential applies **only in sessions that belong to that team**
  (`sessions.team_id`). It never applies in a personal session or in another
  team's session.
- **Only current team members can use it:** a person who is a member, or an
  agent whose owner is a member. Guests, viewers and anyone invited into one
  session without joining the team never get it. This is the line ADR 0004
  drew: joining the team is what grants access, and being added to a single
  session is not.
- Nothing is cached. Who can use a credential is worked out again on every tool
  listing and every call. Leaving the team, the credential being removed, or
  the session moving out of the team each end access on the very next call.
- **Nothing needs attaching.** In a team session, the team's credentials are
  available from the start. That isn't extra access, because **the session's
  grants still decide**. Tools are allowed one at a time and nothing is allowed
  by default (ADR 0014), and only the session owner can change that. Adding a
  team credential allows no tool by itself.

### Your own credential wins

For each integration (the slug, e.g. `sentry`): if you've attached your own
connection to the session, it's used and the team's is ignored. The team's
credential only fills in where you have none. This keeps ADR 0004's attribution
wherever it's possible: if you have your own account, the vendor sees you.

### Marked as shared everywhere it appears

- **To the agent:** each tool's description ends with the credential's source.
  A personal one says `(via sentry, using your own credential)`. A team one says
  `(via sentry, using <team>'s shared credential: the vendor sees the team's
  account, not yours)`. Both kinds share the same tool name, so a prompt that
  works with one works with the other. The description is what tells the agent
  which account it is acting as.
- **In the session's Setup:** team integrations are listed apart from yours and
  labelled *team's · shared*. Where your own replaces one, the label says *you
  use your own*.
- **In Team integrations:** each one is listed with who added it and its recent
  uses.

### Audit stays honest

The vendor's log names one account, the team's, and nothing changes that.
Fabrikka supplies the missing *who*:

- **Every call made with a team credential** is recorded: the credential, the
  session, the person who made it (an agent's owner when an agent did), the
  agent if there was one, the tool's name, whether it succeeded, and when.
  **Arguments and results are never stored.** They can contain anything, and the
  record exists to say who acted, not to copy the vendor's data.
- **Team owners** see recent uses on the Team integrations page. A member sees
  the credential but not other people's use of it.
- Session activity and the changes log name the participant, as before.

## Consequences

- A team connects a shared account once, and every member's agent can use it in
  the team's sessions with nothing to paste. Adding one takes 2 clicks; allowing
  its tools in a session takes 3.
- When there's no personal credential, the vendor's log says "the team" instead
  of a person. We accept that knowingly, the call record is how you find out
  who, and a personal credential always takes precedence over the team's.
- Different members still see different tool lists in the same session.
  Someone who isn't on the team sees none of the team's tools. The UI already
  explains this (ADR 0004's consequence), and the *shared* label adds to it.
- The call log grows with use. There's no retention limit yet. The page shows
  the most recent entries. Pruning can follow, the same way sessions' activity
  gets pruned.
- A team owner who leaves doesn't take the credential with them, because it
  belongs to the team. *Added by* keeps their name. If their account is
  deleted, it shows as unknown.

## Alternatives considered

**Keep 0004 absolute: a team token is pasted in as someone's own.** No new model.
Rejected: every call is attributed to whoever pasted it, which is the
dishonest audit 0004 was meant to prevent. Only that one person's agents could
use it, and everyone else has to paste it again.

**Team credential wins over your own.** Simpler to explain: "the team's Sentry
is the Sentry." Rejected: a team credential exists to fill a gap. Where you
have your own, using it keeps the vendor's log naming you.

**Any member can add one.** Less friction. Rejected for now: a team credential
lends access to everyone on the team, so only someone who can already decide
who is on the team should be able to add one. It can be widened later without
changing the model.

**Attach per session, as personal connections are.** Explicit. Rejected: the
session's per-tool grants are already the explicit step, and asking for an
attach as well would be a copy of it with nothing gained.

**Share with guests too.** Rejected: that brings back ADR 0004's "invited to a
room = handed the keys". Access comes from being on the team.
