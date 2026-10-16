# 0053 — A one-off session is one link to one person, in your Self

**Status:** Proposed
**Date:** 2026-10-16
**Builds on:** [ADR 0007](0007-invites-are-the-only-way-in.md) (an invite link
is the only way in), [ADR 0025](0025-teams-and-who-can-see-a-session.md)
(a session's organization decides the roster, not who may see it),
[ADR 0051](0051-every-session-belongs-to-an-organization-and-an-account-has-its-own.md)
(every session is in an organization; *Self* is yours).

## Context

The owner's third priority, 2026-10-15: *a one-off session with someone. It
should be really easy to download the app, and then kick off some new
session even without inviting the person to the organization.* The pieces
exist: a session invite link makes an account and puts the person in that
session only (M1, M22), and the server serves the desktop app (M33, M34).
What is missing is one place to start from, one name, and a sidebar that
shows such a session to both people.

Since ADR 0051 every session is in an organization. A session for someone
outside all of yours therefore lives in your *Self*, and the other person
is in the session, never in Self. The owner chose the name on 2026-10-16:
**one-off session**.

## Decision

**1. A one-off session is an ordinary session in your Self, started
together with one single-use invite link.** The Self home has a card,
*One-off session*: a title and **Start a one-off session**. One click
creates the session and its link, and shows the link to copy, with the
sentence to send and a button to open the room. The invite is a member invite (the person
takes part; a view-only guest is a different thing and stays M22's guest
toggle in Setup → People), single-use, seven days, as every invite.

**2. The sidebar shows it to both people under One-off sessions.** In Self,
the heading that reads *Organization sessions* elsewhere reads **One-off
sessions**: the sessions in your Self that are not only you, and **the
sessions you are in whose organization is not one of yours**, which is what
a one-off session is from the other side. So the person who was invited
sees it under their own Self, with no organization to join. The **+** beside
*One-off sessions* starts one, the same as the home card. *Individual
sessions* is unchanged.

**3. The invite page says what it is, and offers the app.** *<Name> invited
you to a one-off session: <title>. You join this session, nothing else.*
Under the account form, when the instance serves the desktop app, a link to
download it, with the one-line install for everything else. Nothing else
about invites changes: the same token, the same single use, the same
account.

**4. The other person needs nothing from you but the link.** They are not
added to Self, see none of its other rooms, and their own Self is theirs.
Removing them from the session (Setup → People) ends it; so does the
session's end.

## Consequences

- **Home → title → Start a one-off session → Copy link: 2 clicks and a
  title**, counted from the Self home. From the sidebar's **+** the same.
- Opening a one-off session you were invited to, from a link, selects your
  Self in the switcher, since its organization is not one of yours.
- A member of one of your organizations can be invited the same way; the
  session is still in Self and lists under One-off sessions for both. That
  is fine: a one-off session is about the session, not about who the
  person is.
- No new table, no new endpoint: the home card makes two calls, a session
  and an invite. The invite preview gains the inviter's name.

## Alternatives considered

**A session in no organization, like a direct message.** ADR 0051 just
removed that state for sessions; a direct message has no folders, tools or
agents to resolve, a session does, and they resolve through its
organization: yours.

**A separate kind of session.** It would need its own rules for everything a
session already has. What makes it one-off is how it was started and who is
in it, both of which the record already holds.

**Adding the person to Self.** Self is yours; that is its whole meaning.
