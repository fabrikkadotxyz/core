# 0022 — Nothing leaves a session without a member's deliberate act

**Status:** Proposed
**Date:** 2026-10-03

## Context

M17 makes the invite loop work **inside** an instance: each invitee connects an
agent, and some go on to invite others. The loop cannot cross instances. Signup is
invite-only (M1), every instance is self-hosted, and session existence is private
(non-members get a 404). Someone who has never been in a session has no way to
encounter Fabrikka. Word of mouth between teams needs something a non-user can
see.

Two candidate surfaces exist:

1. **Attribution.** M12–M14 produce documents that leave the session: a LaTeX
   paper gets submitted, a report goes to a client. A credit line on that work
   would put the product in front of the people who read it.
2. **Recaps.** M10's live activity is the best demonstration the product has. A
   shareable summary of a finished session would let someone show what working
   this way looks like.

Both cross the boundary the whole security model is built on. Until now,
everything in a session was visible to its members and to nobody else, and the
only way in was an invite. Each surface puts session-derived content in front of
people with no account, chosen by one member, which may include other members'
words. And the people M12 was built for raise a sharper problem:

- **Students and academics** may be **required** to disclose AI use, or may be
  penalised for it. A credit line on a submitted paper discloses it for them.
- **Office teams** send reports to clients under their own name. A product
  footer in a deliverable is advertising placed in someone else's work.
- **Self-hosting operators** may run an instance precisely so that nothing about
  their work is visible outside it.

This ADR sets the rule both surfaces follow, so the growth loop doesn't grow by
weakening the privacy promise one convenience at a time.

## Decision

**Nothing derived from a session reaches a non-member unless a named member
chooses, at that moment, to send it. Nothing that leaves is hidden from the
person sending it. The operator can turn off both surfaces for the whole
instance.**

### Attribution

- **Exports only, never live documents.** Attribution can appear in a file a
  member explicitly generates: a compiled PDF they download, or a Markdown
  export. Fabrikka **never writes attribution into a live output.** It isn't
  added to the `doc` text, the LaTeX source, or a `gdoc` in someone's Drive.
  Under ADR 0021, every write to a Google Doc is made under the editor's account.
  A footer nobody typed would be a write nobody made.
- **Offered, not defaulted.** The export dialog has an unchecked *Add "Made with
  Fabrikka"* option. Once a member chooses, the choice is remembered for that
  member and stays visible on every later export. It is never silently re-applied.
- **Visible only.** The credit is a line of visible text the sender can read
  before sending. It is never placed in PDF metadata (`Producer`, `Creator`, XMP),
  never in invisible text, and never in a watermark.
- **Identifies nothing.** The line names the product and links to the project's
  public page, as a plain URL with no query string. It never contains the
  instance's host, the session, its participants, its agents, or a referral code.
  A link that identified the session would make a public file a pointer to a
  private room.
- **The operator decides whether the option exists at all.**
  `FABRIKKA_ATTRIBUTION` is `offer` (the default) or `off`. When it's `off`, the
  checkbox is absent, not disabled.

### Recaps

A recap is a **frozen, curated snapshot** of a session, published as a read-only
page. It is not a window into the session.

- **Off unless the operator turns it on.** `FABRIKKA_PUBLIC_RECAPS=1` enables
  the feature. Without it there is no publish control and no public route. This
  is the first unauthenticated read surface an instance would have. Whether a
  given instance should have one is the operator's decision, not a session
  owner's.
- **The owner composes it from what people chose to say.** A recap is assembled
  from items the session already holds and members authored:
  - the session context (objective, decisions, facts);
  - selected messages;
  - excerpts of outputs;
  - a summary the owner writes.

  It **never** includes activity (ADR 0015 redacts that even for the room), tool
  output, integration data, artifacts the owner didn't explicitly pick, or
  anything from an agent's `activity_visible = false` run. Fabrikka does not
  write the summary: there is no built-in model. An agent in the session can
  draft one through the existing tools, and the owner pastes and edits it.
- **Everyone quoted consents to their own words.** Before publishing, each human
  whose messages or output excerpts are included gets a review request covering
  their content, including content written by agents they own. They can approve,
  ask to be shown as *a member* instead of by name, or remove their items.
  **Nothing is published until every quoted member has answered.** Members who
  aren't quoted are not asked. The owner can drop someone's items instead of
  waiting for them.
- **Published at an unguessable URL that grants nothing else.** The page is
  served at `/r/<id>`, where `id` is 128 random bits. The page is static, read-only
  and `noindex`. It contains no session id, owner slug, invite or participant id,
  and holding the URL grants no access to the session. The id is stored in plain
  text: it addresses content that its contributors approved for publication, and
  it unlocks nothing beyond that content.
- **Withdrawable, at any time, by anyone in it.** The owner can unpublish, and
  the route then returns 404, the same answer as for a URL that never existed.
  Any quoted member can later withdraw their items. The recap is then re-rendered
  without them, or unpublished if nothing substantive is left. Copies made
  elsewhere can't be recalled, and the publish dialog says so.
- **Frozen.** Later activity in the session never flows into a published recap.
  Changing it means editing and republishing, and edits go back through consent
  for any newly quoted member.
- A recap page follows the attribution rule: a credit line only if the instance
  has attribution on, linking only to the project page.

## Consequences

- **The cross-instance loop is weaker than a default-on design would make it.**
  Most exports will carry no credit, and most instances may never turn recaps
  on. That's the accepted price. A privacy-first product that advertises through
  its users' private work stops being one.
- **M14 needs no change.** A `gdoc` never receives attribution, so the Google
  Docs milestone is unaffected.
- **Attribution needs an export feature first.** No output kind has a download
  today (M12 and M13 are live-only). The first milestone that adds a PDF or
  Markdown export implements the checkbox.
- **Recaps need their own milestone**, plus schema, protocol, security and
  operations docs written before any code:
  - schema: recaps, their items, and per-member consent rows;
  - protocol: the browser frames for review requests;
  - security: a new threat section for the public read route;
  - operations: both env vars.

  The milestone isn't scheduled. It belongs after M17, whose funnel shows
  whether in-instance invitees stay, which is worth knowing before investing in
  outside reach.
- **"Public sessions" stays on the not-MVP list.** A recap is not a public
  session and must never become a live one by accretion. Any proposal to stream
  a session to non-members supersedes this ADR rather than extending it.
- **Consent can stall a recap**, because a quoted member may never answer. That
  cost is borne by the owner, who can drop that member's items, and never by the
  member who stayed silent.

## Alternatives considered

**Attribution on by default.** This gives the biggest reach for zero effort.
Rejected: it makes the AI-disclosure decision for students and academics, and it
places advertising in client deliverables without the sender noticing. In both
cases the cost falls on the user and the benefit on us.

**Attribution written into the live document** (a footer in the `doc`, a
`\thanks{}` in the LaTeX, a line at the bottom of the `gdoc`). It would travel
with every copy. Rejected: it is content nobody wrote, in a document the team
owns, and for `gdoc` it would appear in Google's revision history under a
member's account (ADR 0021).

**Hidden attribution: PDF metadata, tracking links, referral codes.** This would
measure reach without cluttering the page. Rejected: it sends something the
sender can't see, and a per-instance or per-session code turns a public file into
a pointer back to a private room.

**A live, read-only public view of a session.** This is the most compelling
demo. Rejected: it makes "existence is private" false for that session, exposes
whatever happens next to people nobody chose, and it is the "public sessions"
feature the roadmap explicitly excludes.

**The owner publishes a recap alone.** This is simpler, with no consent round.
Rejected: being invited to a session is consent to that room, not to being
quoted to the world. The owner controls the session, not other members' words.

**Fabrikka writes the recap summary itself.** It would be one click. Rejected:
it requires a built-in model, which the roadmap excludes and ADR 0002's rule
against owning the agent argues against. The agents already in the session can
draft it.

**Host recaps on a central Fabrikka service.** This would give one discovery
surface across all instances. Rejected: it sends a self-hosted instance's content
to a third party, which is what many operators self-host to avoid. Recaps are
served by the instance that holds the session.
