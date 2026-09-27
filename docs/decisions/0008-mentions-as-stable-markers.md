# 0008 — Mentions are stable markers, and mention rows are derived

**Status:** Accepted
**Date:** 2026-09-27

## Context

The product spec is explicit that mentions must be first-class:

> `@claude-fede investigate the webhook handler` should internally resolve to
> `mentions: participant_id: agent_123` rather than relying purely on text parsing.

Two things have to be true at once:

1. A mention must survive a rename. If `@alice` becomes `@alicia`, a message that
   addressed her must still address *her*, not a dangling string.
2. Message text and mention records must not be able to disagree. Storing
   `"ping @alice"` alongside a row pointing at Bob is a state no code should be
   able to produce.

The obvious approach — store the message as typed and keep a separate list of
mentioned participants — satisfies neither. Rename Alice and the stored text
still reads `@alice` forever, while the mention row points at her new identity.
The text and the rows drift apart immediately, and nothing detects it.

Mentions also arrive from two very different writers:

- The **web composer**, which resolves a mention via autocomplete and therefore
  knows the participant id at the moment of typing.
- **Agents over MCP** (M3), which will post ordinary prose containing `@fede`
  and cannot be expected to know internal ids.

## Decision

**Canonical storage is message text containing stable markers, and
`message_mentions` rows are derived from those markers at write time.**

```
stored content:  "I think <@a1b2c3> should look at the webhook handler"
derived rows:    message_mentions(message_id, a1b2c3)
```

The marker `<@participant_id>` references the participant row, never a name.
Display names are resolved **at read time**, so a rename is reflected everywhere,
including in messages written years earlier.

Because the rows are *derived from* the content rather than supplied alongside
it, there is exactly one source of truth and drift is not representable.

### Write path

`post_message` accepts plain text plus an optional `mentions` array of
participant ids, and the server produces the canonical form:

1. For each id in `mentions`, replace the first occurrence of that participant's
   current `@display_name` in the text with `<@id>`.
2. Scan the remaining text for bare `@name` tokens and convert exact matches
   against this session's participants, longest name first.
3. Derive `message_mentions` from the markers now present.

Step 1 serves the composer, which knows ids. Step 2 serves agents posting prose.
An id supplied in `mentions` whose name does not appear in the text still
produces a mention row — that is a deliberate, programmatic mention with no
inline text, which agents will want.

**A participant id that does not belong to this session is rejected, not
ignored.** Silently dropping it would make a cross-session reference look like it
succeeded; see `docs/security.md`.

### Read path — two projections of one storage format

| Consumer | `content` | Why |
| --- | --- | --- |
| Web API | markers preserved, plus `mentions: [{participantId, displayName, kind}]` | The client renders chips and needs structure, not prose |
| MCP API (M3) | markers expanded to `@display_name`, plus the same `mentions` array | An agent should receive readable text, not internal ids |

Same storage, two renderings. Neither is authoritative over the other.

## Consequences

- A rename is correct everywhere, retroactively, with no migration or backfill.
- Content and mention rows cannot disagree, because one is computed from the other.
- Raw `content` is not directly displayable. Every consumer must render markers,
  and a consumer that forgets will show `<@a1b2c3>` to a user. The web client and
  the MCP projection are the only two readers, and both are covered by
  acceptance checks.
- Marker syntax is now part of the stored data. Changing it later means a
  migration, so it is specified in `docs/protocol.md` rather than left implicit.
- Literal text a user typed can be rewritten by step 2. Someone writing
  `email me @fede` gets a real mention. This is the same behaviour as every chat
  product and is what users expect; the composer makes it visible before sending.
- Display-name uniqueness per session becomes load-bearing, since step 2 resolves
  by name. Already enforced by `unique (session_id, display_name)`.

## Alternatives considered

**Store text as typed, keep a separate mention list.** Simplest to write, and the
mention rows alone satisfy a narrow reading of "mentions are first-class".
Rejected: renames leave the text permanently stale, and text and rows can drift
with nothing to detect it.

**Parse `@name` at read time, store no rows.** No write-side work at all.
Rejected outright — this is precisely what the spec says not to do. It makes
every read a name lookup, breaks the moment a name changes, and gives delivery
(M4–M6) nothing reliable to key on.

**Store rendered text *and* markers in separate columns.** Fast reads, no
rendering step. Rejected: two representations of the same fact, which is the
drift problem again with extra storage.

**Offsets into plain text (`{start, end, participantId}`).** Keeps content
human-readable. Rejected: any edit invalidates every offset after it, and
multi-byte characters make the arithmetic a recurring source of bugs.
