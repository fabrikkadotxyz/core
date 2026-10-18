# 0057 — Leaving: an account is deactivated, then deleted; the record stays

**Status:** Proposed
**Date:** 2026-10-18
**Builds on:** [ADR 0022](0022-nothing-leaves-a-session-without-a-members-deliberate-act.md)
(nothing leaves a session without a member's deliberate act),
[ADR 0025](0025-teams-and-who-can-see-a-session.md) (teams),
[ADR 0051](0051-every-session-belongs-to-an-organization-and-an-account-has-its-own.md)
(every session is in an organization; an account has its own, *Self*),
[ADR 0029](0029-the-core-is-a-library-a-deployment-extends-it.md) (the kit).

## Context

Today the only way out of Fabrikka is `admin delete-user`, which deletes the
`users` row. Teams cascade on their creator, sessions cascade on their team
and on their owner, messages cascade on their participant. **Deleting one
person deletes every room in every team they created, with everyone else's
messages, decisions and files in it.** That contradicts the third promise in
`PRINCIPLES.md`, a record that outlives the chat: what you wrote in rooms
other people still use should stay there.

Two different needs hide behind "delete my account":

- **Stop.** An account an operator suspends, a person on leave, a member an owner wants
  out without destroying anything. Reversible.
- **Go.** A person who wants Fabrikka to hold nothing about them. Under the
  GDPR this is the right to erasure, and it is not absolute: other people's
  legitimate interest in an intact shared record, knowing who said what and
  who decided what, is a recognised ground for keeping a name on content.
  It is, however, a ground the person can contest, so they must be offered
  the alternative.

The owner's decisions (2026-10-18): deactivation is a state of its own; a
deleted account keeps its display name on what it wrote **by default**, shown
as deactivated, and the person may choose to have the name removed instead.

## Decision

**1. Two states beyond active: deactivated, then deleted.**

| | Deactivated | Deleted |
| --- | --- | --- |
| Sign in | Refused | Refused, forever |
| Personal data | Intact | Removed (below) |
| Content they wrote | Intact | Intact |
| Name on content | Shown, marked *deactivated* | Shown, marked *deactivated*, **or** replaced by `former-member` if they chose so |
| In rosters and pickers | Listed with the mark, not mentionable | Listed with the mark where their content is, not mentionable |
| Reversible | Yes: an operator or the deployment reactivates | No |

Deactivation wakes nothing and consumes nothing: a mention of a deactivated
person is plain text.

**2. Deletion is asked for, then happens after a grace period.** *Settings →
Account → Delete my account* asks for the password, says what stays, and
offers the one choice: keep my name on what I wrote (default) or remove it.
The account is deactivated at once and every login session ends. **Signing
in within 14 days cancels the deletion** and reactivates the account; the
sign-in says so. After 14 days a daily job deletes. The operator's CLI and
the kit may delete at once, for a request made elsewhere.
When mail is configured, a confirmation goes to the address at request time,
with the date it takes effect.

**3. What deletion removes:** the email (replaced by a sentinel in the
reserved `.invalid` domain, so the row stays unique and nothing can be sent
to it), the password hash, the verified-at date, preferences and the welcome
answers, every login session, password reset, vendor connection and its
sealed tokens, OAuth flow, device and pairing, grant default, personal
template, and every agent they registered with its connections and tokens.
Team and session memberships end. Invites they created are revoked.

**4. What deletion keeps:** the `users` row, as a tombstone with
`deleted_at` set; every participant row with everything that hangs off it:
messages, mentions, comments, output edits, runs, context history, call
records (attributed by participant id); outputs and files in rooms other
people are in. The display name on those participants stays as it was, or,
if they chose removal, becomes `former-member` (numbered within a session,
because a session's participant names are unique). The tombstone's own
`display_name` follows the same choice.

**5. What they alone had goes with them.** A session with no other human
member, including the individual sessions in their *Self*, is deleted with
its content: there is no one left to keep the record for. A direct message
stays for the other person.

**6. Ownership passes, it does not vanish.** A session they owned that other
humans are in passes to its oldest remaining owner, else its oldest member.
A team they owned passes to its oldest other owner, else its oldest member;
a team with no other member is deleted unless one of its sessions still has
another human in it, in which case the team stays without an owner and its
remaining sessions are reachable to their members as before. Their *Self* is
treated the same way: one-off sessions with other people in it survive it
(ADR 0053). A passed session keeps its public id but its MCP endpoint path
changes, because the path names the owner (ADR 0006): the agents of the
person who left are gone, and the others re-add the room from Setup.

**7. The application never deletes a `users` row.** The cascades that made
one delete wipe shared content are replaced: a team's creator, a session's
owner and a participant's user no longer cascade (`restrict`, and `set null`
for the participant), so a stray delete fails instead of destroying a
record. The personal-data cascades (memberships, sessions, tokens, devices)
stay, because they are what deletion removes anyway.

**8. The kit gets the verbs, not the policy.** `deactivateUser(userId)`,
`reactivateUser(userId)`, `deleteUser(userId, { eraseName, now })` and
`onUserDeleted(listener)`. A deployment decides when to call them, and the
listener lets it clean up what it keeps about the person. The core's own
grace and wording are the same for every deployment.

## Consequences

- `users` gains `deactivated_at`, `deletion_requested_at`, `deleted_at` and
  `erase_name`. Login and token resolution refuse a deactivated or deleted
  account. Rosters, People pages and the mention picker read the state.
- `admin delete-user` becomes this operation, with `--erase-name` and
  `--now`; `admin deactivate-user` and `admin reactivate-user` are added.
- An operator's privacy policy can now say what stays when someone leaves,
  and offer the choice.
- M60's audit trail records the request, the cancellation, the deletion and
  every ownership transfer. Until then the server log does.
- A later milestone (M62) builds per-person export; it reads the same
  tables this ADR says are personal.
