# 0058 — The trail: who did what, kept per organization, never what they said

**Status:** Proposed
**Date:** 2026-10-18
**Builds on:** [ADR 0028](0028-team-credentials-are-shared-marked-and-lose-to-your-own.md)
(call records: who acted through a shared credential, never what they sent),
[ADR 0057](0057-leaving-an-account-is-deactivated-then-deleted-the-record-stays.md)
(leaving), [ADR 0029](0029-the-core-is-a-library-a-deployment-extends-it.md)
(the kit).

## Context

The server remembers what happened in a room, in detail, and almost nothing
about what happened *to* the room: who let someone in, who widened an
agent's grants, who exported it, who tried to sign in as whom and failed.
Eight `console.log` lines are the whole record, and they end with the
process.

Three readers need more. **An organization's owner**, who shares credentials
and rooms with people and their agents and is accountable for both. **A
person**, who under the GDPR may ask what was done with their account. **An
auditor**, whose first evidence request for a SOC 2 Security report is a
log of access and privileged changes, with retention.

The one thing the trail must never become is a second copy of the content.
Messages, outputs and tool arguments are the room's record, kept and deleted
with it ([ADR 0022](0022-nothing-leaves-a-session-without-a-members-deliberate-act.md)).
Call records already draw that line (ADR 0028): who, which tool, when,
whether it worked, and nothing they sent.

## Decision

**1. One table, `audit_events`, one writer.** An event is: when, the action
(a dotted name from a fixed list), who did it (a user, the operator's CLI,
the system, or a deployment), to whom if anyone, in which organization and
room if any, the client address, the outcome (`ok`, `refused`, `failed`),
and a small `detail` of identifiers and names: a tool's name, a role, a
slug, a room's title. **Never message content, never a tool's arguments,
never a credential or token.** Every write goes through `audit()`; it never
throws into the action it describes, and an event is recorded only after the
action committed.

**2. What is recorded.** Sign-in, its failure and its lock; sign-out;
password reset asked and completed; an account deactivated, reactivated,
asked to be deleted, kept, deleted; an organization created, a member added
or removed, an invite created, revoked or redeemed; a room deleted or
exported; a member or guest added or removed; an agent added, its trust
changed, a token issued or revoked, agents paused or resumed; a vendor
connection attached or removed, for a person or an organization; a tool
grant changed; and every command of the operator's CLI. The list is in
`audit.ts`, and adding to it is a doc change first.

**3. Who reads it.** An organization's owners read their organization's
trail: events in it or in its rooms. A person reads the events they did or
that were done to them, in any organization, under *Settings → Account*.
The operator reads everything, with `admin audit`. Nobody else. A member of
an organization does not see its trail: it says who was removed and who
failed to sign in, which is the owners' business.

**4. How long.** Per organization, `teams.audit_days`: 365 by default, one
of 90, 180, 365 or 730, a fixed list so the privacy policy can name every
answer, like call records (M43). Events in no organization (a sign-in, a
personal connection) follow the instance's `FABRIKKA_AUDIT_DAYS`, 365 by
default. A daily job prunes, and shortening the setting prunes at once.

**5. Names resolve at read time.** An event stores ids. The reader sees the
display name as it is now, which is how a person who left under
`former-member` (ADR 0057) stops being named in the trail without a rewrite.
An event about a deleted room keeps the title it had in `detail`.

**6. The kit gets the writer and the reader.** `audit(event)` lets a
deployment's own events, such as its sign-ups, land in the same trail, as
`deployment`; `auditEvents(teamId, filter)` lets it show them. The list of
actions is the core's; a deployment prefixes its own with `deployment.`.

## Consequences

- `audit_events` and `teams.audit_days` (migration 0042). `docs/data-model.md`.
- The routes named in §2 each gain one `audit()` call; `leaving.ts` and the
  CLI write their own. The M59 sign-in log line becomes an event.
- *Settings → Activity*, for owners: the list, a filter by kind, a CSV
  download, the retention setting. *Settings → Account* shows the person
  their own recent events.
- `admin audit [--team <id>] [--since <date>] [--action <prefix>] [--limit n]`
  for the operator.
- M62's per-person export includes a person's events. M63 generalises the
  retention setting to messages and files.
- Not in scope: alerting on the trail, shipping it elsewhere, or signing it.
  A SOC 2 report will want the first two; they are deployment concerns on top
  of this table, not changes to it.

## Amended 2026-10-18: retention beyond the trail (M63)

The same model, §4, extends to what the rooms hold. `teams` gains
`message_days`, `output_days` and `file_days`: how long an organization keeps
messages (by when they were written), documents (by their last edit) and
uploaded files (by when they were added). Each is **null, forever, by
default**: a self-hoster who said nothing loses nothing. Each is one of 30,
90, 180, 365 or 730 days once set, by an owner in *Settings → Activity* or by
a deployment through the kit (`setRetention`), so a deployment can set a
default. The daily job deletes past the windows across the organization's
rooms, shortening a window deletes at once, and every run that removed
something is one event (`retention.pruned`, with counts) in the trail.

What retention never touches: the room's notes (ADR 0059), its links, the trail itself, and who was in the room.
A message's deletion takes its mentions; a document's takes its edits and
comments; a file's takes its row and leaves the blob, as removing a file by
hand does. Not built here: a bin for deleted rooms. A deleted room is gone at
once, as before; a 30-day bin with restore is a later milestone.
