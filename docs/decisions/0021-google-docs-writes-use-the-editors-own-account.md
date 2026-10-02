# 0021 — Google Docs writes go through the editor's own Google account

**Status:** Proposed
**Date:** 2026-10-01

## Context

The `gdoc` output kind (M14) exists because many teams — office workers, students on
school accounts — already live in Google Docs and will not move. Fabrikka has to
read and write a Google Doc on behalf of people and their agents, which means
holding Google OAuth credentials.

The question is whose. ADR 0004 settled it for MCP aggregation: a session that owns a
credential silently lends one person's access to everyone invited, and every audit log
then blames that person. Google Docs has the same audit log — revision history names
an account for every change.

This is also the first time Fabrikka is itself an OAuth **client** of a third party
(ADR 0009 deferred OAuth for our own tokens; that is a different direction and still
stands).

## Decision

**Every write to a Google Doc uses the Google account of the person responsible for
it: a member's own edits use theirs, and an agent's edits use its owner's.**

- A member connects Google once, from the Setup pane, like attaching an integration.
  The refresh token is sealed under `FABRIKKA_ENCRYPTION_KEY` and **connecting is
  refused if no key is set** — the ADR 0014 rule, unchanged.
- `claude-alice` editing a doc writes as Alice. Google's revision history says Alice;
  our `output_edits` log says `claude-alice`, run id included. Between the two, every
  change is attributable to both the human accountable and the agent that made it.
- A participant whose owner has not connected Google gets a clear refusal on
  `edit_output` (`credential_missing`), naming what to do. Writes **never** borrow
  someone else's credential.

### Reads are the one deliberate exception

Creating a `gdoc` output in a session is its creator publishing that document to the
room, the same act as uploading an artifact. So **reads for display and for
`read_output` use the reader's own credential if they have connected one, and the
creator's otherwise.** A member without a Google account can still see what the
group is writing; they cannot change it through us.

The exception is bounded: it reaches only the one file the creator attached to this
session, and only for reading. It cannot reach anything else in the creator's Drive.

### Least scope: `drive.file`

We request `https://www.googleapis.com/auth/drive.file` — access only to files the
app created or the user explicitly opened with it — not `drive` or `documents`
(full-Drive scopes that Google classifies as restricted). A Fabrikka instance should
not be able to read anyone's whole Drive, and a self-hoster should not need Google's
security assessment to run one.

The cost of `drive.file` is that each member must open a doc through the app once
(the Google Picker) before *their* token can write to it, even though it is shared
with them. The Setup flow does this as one click when a member first edits a doc.

### What "live" means here

Human edits made directly in Google Docs do not pass through Fabrikka. While someone
has a `gdoc` output open, the server polls the document's revision and the Drive
revisions list, refreshes the preview, and records each new revision in the changes
log with the Google account Drive reports. That attribution is coarser than ours —
per revision, not per edit — and the changes view says so.

### Must be verified before building

Like Cursor's headless MCP at M16, three claims here come from documentation, not
from running it:

1. A member who has the file shared with them but did not create it can write to it
   with a `drive.file` token after picking it once in the Picker.
2. Anchored edits map onto the Docs API: read the body, locate `old_text` uniquely,
   apply a `batchUpdate` delete and insert with `writeControl.requiredRevisionId` from
   that read, and retry once on a revision race.
3. Whether the Docs editor can be embedded in the pane, or only a preview. If only a
   preview, the pane shows our rendered export with an "Open in Google Docs" button.

## Consequences

- Each instance needs its own Google Cloud OAuth client, configured by the operator
  (`docs/operations.md`). An instance without one simply does not list `gdoc` in the
  catalogue — absent, not broken.
- Agent edits arrive as **plain text**. Markdown in `new_text` is not converted to
  Google formatting; the Docs API has no markdown insert, and pretending would be
  worse than saying so. Reading uses Google's Markdown export, so agents read
  structure even though they write text.
- Every member who wants to edit through Fabrikka needs a Google account. Members
  who do not can still read. Teams that want nothing to do with Google use `doc`.
- The session's work lives in the creator's Drive. If the creator leaves the session
  or disconnects Google, the output becomes read-only for everyone without their own
  access, and the pane says why.
- OAuth client secrets join the encryption key on the list of things an operator
  must back up and protect.

## Alternatives considered

**One Google account per session** (the owner's, or a service account). One
connection, every member can edit through it. Rejected: it is the confused deputy of
ADR 0004 again — Google's history attributes every agent's and every member's change
to one person, and inviting someone grants them that person's write access.

**Full `drive` scope.** Removes the one-click Picker step. Rejected: it lets the
instance read everything in every connected Drive, and it is a restricted scope
requiring Google's verification for any instance with more than test users.

**Google Workspace add-on instead of an adapter.** Lives inside Docs, where users
already are. Rejected for now: it inverts the product — the session becomes a
sidebar in someone else's editor — and it requires Marketplace publishing per
instance.

**Do not attribute human edits made in Google Docs.** Simpler; we only know about
edits that came through us. Rejected: "see what they are changing" is the point of
this milestone, and a changes log that silently omits half the editors would
mislead.
