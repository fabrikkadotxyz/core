# 0062 — Self is one person; working together is an organization

**Status:** Proposed
**Date:** 2026-10-22
**Amends:** [ADR 0051](0051-every-session-belongs-to-an-organization-and-an-account-has-its-own.md)
(an account has its own organization, *Self*) and
[ADR 0041](0041-a-deployment-can-gate-accounts-and-team-writes.md)
(where a deployment may say no). Keeps
[ADR 0053](0053-a-one-off-session-is-one-link-to-one-person.md) (one-off
sessions) as it is.

## Context

ADR 0051 gave every account its own organization, *Self*, and said its
person cannot leave it. It did not say that nobody else can join it, and the
core let an owner make an organization invite link for Self like for any
other. Whoever opened it became a member of someone else's Self: their
switcher showed two *Self*s, and Self stopped meaning *yours*.

The owner, 2026-10-22: *Self is for only one person.* Working with other
people is an organization.
Asked about one-off sessions, which live in Self and take people by a link,
the owner chose to keep them: the people are in that one session, never in
Self.

## Decision

**1. Self has exactly one member, its person.** The core refuses an
organization invite for Self (`POST /api/teams/:id/invites` answers 400), and
redeeming one made before this change fails (`self`). Settings has no
*People* page in Self, since there is nobody to list or invite. The
migration revokes open organization invites to a Self, and takes anyone but
its person off one, together with the session access that came from it.

**2. Sessions in Self still take people, by link.** A one-off session, a
member or guest invite, and the session's own People are unchanged: the
person is in that session and nowhere else in Self (ADR 0053, *4*).

**3. Creating an organization and joining one are writes a deployment may
check.** Two more `action` names for `guardWrites` (ADR 0041):

| `action` | When | `teamId` | `userId` | `ownerUserId` |
| --- | --- | --- | --- | --- |
| `organization` | `POST /api/teams`, before the organization exists | `null` | the creator | the creator |
| `join` | redeeming an organization invite, before it is claimed | the organization | the person joining, or `null` when they sign up through the link | the person who made the invite |

A refusal answers 402 as every gated write does, and the invite is not used
up, so the same link works once the deployment allows it. Signing up through
a refused link creates no account. On an instance with no extension nothing
is checked: whoever runs the instance makes as many organizations, with as
many people, as they like.

**4. The kit tells a deployment which organization is someone's Self.**
`kit.team(teamId)` gains `ownOfUserId`, the account whose Self it is, or
`null`. A deployment can then treat Self differently from an organization
without a query of its own.

## Consequences

- *Self* means one thing in every switcher: you, alone. Working with other
  people, beyond a one-off session, is an organization.
- A deployment can decide who creates and joins organizations, through the
  checks it already has, and leave Self out of them.
- An account that was a member of someone else's Self loses it in the
  migration, and the sessions it reached through that membership; a session
  it was invited to directly stays. On the instances this was written
  against, no Self had a second member.
- `createAccountWithOwnTeam` is unchanged: a deployment's own sign-up makes
  its organization directly, and the deployment decides there.

## Alternatives considered

**Remove one-off sessions too,** so that nobody but you is in anything in
Self. Considered and declined by the owner: a one-off session is the
quickest way to work with someone once, and it gives them nothing beyond
that session.

**Keep Self open and let a deployment refuse invites to it.** Every
deployment, and every self-hosted instance, would face the same two-*Self*
confusion; it is the core's meaning of Self, so the core holds it.
