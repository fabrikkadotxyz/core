# 0059 — A room keeps notes, not a form

**Status:** Proposed
**Date:** 2026-10-18
**Supersedes:** the *session context* half of [ADR 0013](0013-context-is-append-only-with-explicit-removal.md).
Its other half, content-addressed artifacts, stands.
**Builds on:** [ADR 0001](0001-session-is-an-mcp.md) (the session is an MCP),
[ADR 0022](0022-nothing-leaves-a-session-without-a-members-deliberate-act.md).

## Context

Since M3 a room has carried a form: an *objective*, and four lists named
*facts*, *decisions*, *open questions* and *constraints*. Agents wrote to it
through `update_session_context`, people through a panel, and the export, the
catch-up card and the templates all read it by slot.

The form was ours, not the room's. It fits an incident and a pitch and fits a
paper, a hiring loop or a reading group badly; an agent that learned something
that was none of the four had to choose a slot or stay silent; and the panel
sat open in every room, five empty headings telling people what kind of work
they were supposed to be doing. The owner's decision (2026-10-18): the record
agents and people keep outside the conversation stays, and **the structure
goes**.

What ADR 0013 got right stays: a shared record is append-first, because an
agent and a person writing at once must not lose each other's work, and
removal is explicit.

## Decision

**1. Notes.** A room has a list of notes. A note is free text, written by a
participant (a person or an agent) at a time, with an **optional tag**: one
word the writer chose, `decision`, `risk`, `todo`, anything, or nothing. No
fixed list of tags, no slot, no objective field. The room's title says what
the room is for.

**2. Append-first, removal explicit, history kept.** Adding a note never
touches another. Removing a note is by id, by anyone in the room, and is a
soft removal: the note keeps its author, time and tag, marked removed by whom
and when, so the export and the catch-up can still say what was there. There
is no wholesale replacement and therefore no version to carry.

**3. Over MCP: three tools replace two.** `get_notes` (live notes, newest
last, with id, text, tag, author, time), `add_note({ text, tag? })` and
`remove_note({ id })`. `get_session_context` and `update_session_context`
are gone. An agent is told what a note is for in the tool description and is
told nothing about what to tag.

**4. Hidden by default.** In the room the notes live in a collapsed panel,
*Notes (n)*, opened on demand; nothing about them is shown until someone
asks. In the export they are an appendix after the timeline, not the opening
section. The catch-up card lists notes added, and notes removed, since the
person's last visit, under *Noted*.

**5. What already exists migrates, tagged.** Every item of the old form
becomes a note with the old slot as its tag, singular: `fact`, `decision`,
`question`, `constraint`; the objective becomes a note tagged `goal`. Author
and time come from the context history where it has them. Nothing is lost,
and nothing stays privileged: those tags are words like any other from now
on.

**6. Templates seed notes, and copy none.** A built-in template's starter
objective, constraints and questions become its starter notes, tagged. Saving
a room as a template copies its documents and suggested connections, and the
starter notes of the template it was itself made from; it copies none of the
room's own notes, which are content.

## Consequences

- `session_notes` replaces `session_context` and `context_events` (migration
  0045, with the data migration in §5). `session_reads.context_seen` becomes
  `notes_seen_seq`. `docs/data-model.md`.
- `docs/protocol.md`: the tools table, the append-first section and the
  handoff paragraph. Agents in the wild re-read the tool list; before the
  first release that costs nothing.
- The room panel, the catch-up card, the export's README and `session.json`
  (`notes`, `removedNotes`; `context` and `contextHistory` are gone), the
  templates' body (`notes` replaces `objective`, `constraints`, `questions`).
- ADR 0013 stays accepted for artifacts and is marked superseded for context.
  ADR 0018's three panes are unchanged: the right pane has one fewer open
  panel.
- The acceptance checks for M3, M7, M24, M25 and M27 are rewritten for notes.
  The lost-update scenario of M7 still holds: two writers appending notes at
  once lose nothing.
