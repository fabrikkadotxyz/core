# 0019 — Outputs are live documents behind one adapter contract

**Status:** Proposed
**Date:** 2026-10-01

## Context

ADR 0018 named the right pane **Output** and made a claim the product has to keep:
"if the right pane is still just context and artifacts in six months, the thesis
is weaker than we said." Today it is exactly that, and neither half can be
*worked on*:

- **Context** is lists of sentences. Good for an objective and a decision log;
  not where an essay, a report or a paper gets written.
- **Artifacts** are immutable by design (ADR 0013): content-addressed blobs. An
  agent that wants to change `report.md` creates `report.md` again, and the people
  in the room diff two files by eye.

So nothing in a session can be edited in place by several humans and several
agents at once, and nobody can see *who changed what*. That is the core activity
of the people we want next — students writing a group report, academics on a
paper, an office team on a proposal. They do not want to read about a document in
a chat; they want to work on the document with the chat beside it.

Two more forces:

- **Teams already have a home for documents.** Some will never leave Google Docs;
  an academic's paper is LaTeX whatever we think of it. A Fabrikka that only
  offers its own editor asks them to move, and they will not.
- **The protocol is public.** Agents bind to `docs/protocol.md`. If every output
  kind brings its own MCP tools (`gdocs_insert`, `latex_patch`, …) the agent-facing
  surface grows with the catalogue and an agent prompt has to know which kind it
  is looking at before it can write a sentence.

## Decision

**An output is a live, editable, attributed document owned by the session. Every
kind of output sits behind one adapter contract, and agents see one set of tools
whatever the kind.**

### Outputs are not artifacts

| | Artifact (M7) | Output (M12) |
| --- | --- | --- |
| Mutability | Immutable, content-addressed | Edited in place |
| Who edits | Nobody; you create a new one | Every member and their agents, concurrently |
| History | None needed | Every edit attributed to a participant |
| Storage | Blob on disk | Adapter-defined: in our database, or in someone's Google Drive |

Both stay. A figure, a CSV or a compiled PDF is an artifact; the thing being
written is an output. An output can reference artifacts (a LaTeX output mounts
them as figures, see ADR 0020).

### The adapter contract

An adapter is a server-side module for one **kind** (`doc`, `latex`, `gdoc`). It
implements:

| Part | Responsibility |
| --- | --- |
| `create` | Make a new output of this kind, empty or from initial content |
| `read` | Return the content of one file as text, plus a `version` |
| `edit` | Apply anchored edits (below) atomically, as a named participant |
| `changes` | Return the attributed edit log |
| `render` | Tell the web client which view to mount (editor, PDF preview, embed) |

An output is a set of named **text files**: a `doc` has one (`document.md`), a
`latex` output has `main.tex` and whatever else it needs, a `gdoc` has one virtual
file. Agents address files by path; omitted, the main file is meant.

### Agents edit by anchor, not by offset or version

The agent-facing edit is a list of `{ old_text, new_text }` pairs. Each `old_text`
must occur **exactly once** in the file *at the moment the edit is applied*; all
edits in a call apply or none do.

The anchor *is* the conflict check. A human typing in another paragraph between
the agent's read and its write does not invalidate the write, because the
paragraph the agent quoted is still there, once. A human rewriting the very
sentence the agent quoted does invalidate it, and the agent gets
`anchor_not_found` and re-reads. That is the behaviour people expect from a
colleague, and it is the same shape as the editing tools agents already use on
local files, so they need no new habit.

Replacing a file wholesale is allowed only with `if_version` — the ADR 0013 rule,
for the same reason: writing back "the whole document" must not silently delete a
paragraph someone typed a minute ago.

### Native kinds are CRDT documents on the socket we already have

`doc` and `latex` store each file as a Yjs `Y.Text`. Browsers sync over a
per-output WebSocket speaking the standard Yjs sync and awareness protocols, so
two humans type in the same paragraph and see each other's cursors. An agent's
`edit_output` is applied **server-side** as a Yjs transaction whose origin is the
agent's participant id, so it merges with in-flight human typing exactly like a
third person typing.

The server holds an open output's `Y.Doc` in memory and persists its encoded state
on a debounce and when the last client leaves. Yjs is the one CRDT we adopt; the
markdown and LaTeX editors are both CodeMirror bound to `Y.Text`, so the second
native kind is mostly a different preview pane.

### Attribution is a durable log; the timeline gets display-only frames

Every edit writes an `output_edits` row: who (participant, and run if there is
one), when, lines added/removed, and the diff. Agent edits are one row per
`edit_output` call. Human typing is **coalesced** per participant per output into
one row after ten seconds idle — a row per keystroke records nothing anyone will
read.

The session stream carries an `output.edited` frame so the timeline can say
*claude-alice edited Report (+12 −3)* with a link to the diff. Like activity
(ADR 0015) this is **display data**: it is not a message, it never wakes an agent,
and it never counts against the turn budget. An edit is not a mention.

### The catalogue is the seed of a marketplace; this ADR does not build one

The server exposes the list of output kinds it has — name, description, what the
kind needs (for example a connected Google account), and whether the viewer can
use it now. The right pane's **Add output** picker renders that list. That is the
shape a marketplace needs.

What this ADR deliberately does **not** do is let anyone other than this
repository add a kind. A third-party adapter is server-side code that receives
documents and, for some kinds, credentials. Loading one needs isolation, review
and a publishing story we have not designed. Built-ins first; the contract above
is what a third party would eventually implement, and having three real
implementations is how we will know it is the right contract.

### In the right pane

Outputs are listed first in the Output pane, above context and artifacts.
Opening one widens the right pane to its maximum (60% of the window, the M11
clamp) and closing it restores the width the viewer had chosen. The middle pane
still never collapses (ADR 0018) — the point is the document *beside* the
conversation.

## Consequences

- `docs/protocol.md` gains four tools (`list_outputs`, `read_output`,
  `edit_output`, `create_output`) and they have to stay stable as kinds are added.
  A kind that cannot honour anchored edits cannot be an adapter.
- Two new dependencies on both server and web: `yjs` and its protocol helpers;
  the web adds CodeMirror and its Yjs binding. They are the cost of real-time
  co-editing; writing our own merge would cost more and be worse.
- Server memory now holds open documents. At MVP scale (a handful of open outputs)
  this is trivially fine; it is a known limit on a single process, and it is why
  state is persisted on debounce rather than only on close.
- Output content is **untrusted input** to every agent that reads it, exactly
  like messages. A member can write instructions into a document; the trust tiers
  in `docs/security.md` already treat that as data, and this does not change them.
- Edits never trigger delivery. An agent that should respond to a document change
  has to be mentioned. This is less magic and more predictable, and it keeps the
  turn budget meaningful.
- Each output kind's editor in the web client is real UI work. The contract keeps
  the protocol small; it does not make the frontend free.

## Alternatives considered

**Make artifacts mutable.** Smallest schema change. Rejected: content addressing
is what makes two people uploading `notes.md` safe (ADR 0013), and a mutable
artifact needs versioning, merging and attribution, which is everything in this
ADR wearing the old name.

**Kind-specific MCP tools** (`gdocs_*`, `latex_*`). Each kind exposes exactly
what its backend can do. Rejected: the agent-facing surface grows with every kind
and agents must branch on kind before writing. Kind-specific power can be added
later as optional tools; the common path must be one shape.

**Strict versioning for agent edits** (reject any edit whose base version moved).
Simplest correct rule. Rejected: with humans typing continuously, the version
moves every second, and an agent would almost never land an edit. The anchor is a
finer-grained version check that fails only when it should.

**Last-write-wins plain text, no CRDT.** No new dependency. Rejected: two people
typing in the same document at once is the use case, and last-write-wins loses
one of them.

**Use Google Docs for everything.** It already has real-time co-editing and
history. Rejected as the only option: it requires every participant to have and
connect a Google account, it stores the session's work outside the instance, and
it cannot be self-hosted. It is one adapter (ADR 0021), not the foundation.

**Third-party adapters now.** The marketplace is the stated goal. Rejected for
this milestone: running other people's code beside credentials needs isolation we
have not designed, and a contract with one implementation is a guess.
