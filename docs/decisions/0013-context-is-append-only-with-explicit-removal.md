# 0013 — Session context is append-first, and artifacts are content-addressed

**Status:** Accepted
**Date:** 2026-09-28

## Context

M3 shipped `update_session_context` with patch semantics: pass `facts` and the
whole array is replaced. That is correct for one editor and wrong for a shared
room, which is the entire premise of the product.

The failure is ordinary and silent:

```
10:00  fede types three facts in the browser
10:01  @claude-fede calls update_session_context with the two facts it knows
10:01  fede's third fact is gone, with nothing to indicate it ever existed
```

Nobody did anything unreasonable. The agent read the context at 10:00, added
what it learned, and wrote back what it believed the complete list to be. This is
the classic lost update, and it will happen constantly once both a human and an
agent are editing.

Artifacts raise a smaller version of the same question: what happens when two
participants upload a file with the same name.

## Decision

### Context lists are append-first; removal is explicit and by value

`update_session_context` gains `add_*` / `remove_*` operations, and these are what
agents are told to use:

| Operation | Effect |
| --- | --- |
| `add_facts: [...]` | Appends, skipping exact duplicates |
| `remove_facts: [...]` | Removes by exact value |
| `facts: [...]` | Replaces wholesale — still available, never suggested |

Appending is the overwhelmingly common intent: *I learned something, record it.*
Making that the easy path means the common case cannot lose data, and the
destructive case has to be asked for by name.

Removal is **by value, not by index**. An index is meaningless the moment anyone
else appends, so index-based removal would delete the wrong item precisely when
the session is busiest.

`objective` stays a single field with plain replacement. It is one sentence, and
two people rewriting it simultaneously is a conversation to have, not a merge to
perform.

### Wholesale replacement requires the version you read

The replace form stays, because sometimes you really do mean *this is the list
now* — a human editing in the browser, for instance. But it takes an `if_version`
matching what the caller last read, and a mismatch is rejected:

```
update_session_context(facts: [...], if_version: 7)   -> 409 if context is at 8
```

`session_context.version` increments on every write. A human sees "someone else
changed this, reload"; an agent gets an error telling it to re-read and retry.
Neither silently destroys work.

### Agents may create artifacts, and content is addressed by hash

An agent producing `investigation.md` is the point of the product, so
`create_artifact` exists alongside `list_artifacts` / `read_artifact`.

Stored files are named by the **SHA-256 of their content**, not by their filename.
Two participants uploading `notes.md` get two artifacts with one stored blob, and
neither overwrites the other — a filename collision becomes a non-event rather
than a data loss. The display name lives on the row.

Storage is a local directory by default, because a self-hoster should not have to
configure object storage to attach a CSV. The path is one setting, so cloud swaps
it without touching anything else.

## Consequences

- The common agent path (`add_facts`) cannot lose a human's edit, which is the
  whole point.
- Two clients appending concurrently both succeed, and both facts survive. That is
  the correct outcome and needs no coordination.
- The replace path can now fail with a conflict, so the browser has to handle a
  409 by reloading rather than assuming success. Small cost, and it is the only
  honest option.
- `version` must be returned everywhere context is read, or the replace path
  cannot be used at all.
- Deduplicating on append means a genuinely repeated fact is silently dropped. An
  acceptable trade: a duplicated line is noise, and the alternative is a context
  that accumulates the same sentence every time an agent re-reads and re-adds it.
- Content addressing means deleting an artifact must not delete a blob another
  artifact still references. Reference counting, or simply never collecting
  garbage at MVP scale — we do the latter and say so.

## Alternatives considered

**Leave patch semantics and tell agents to read-modify-write carefully.** No code
change. Rejected: it makes correctness depend on every agent behaving perfectly
under concurrency, and the failure is silent. The instruction-with-an-opt-out
lesson from M5 applies — if losing data is the easy path, it will happen.

**Full optimistic concurrency on every write, no append operations.** Uniform and
simple to explain. Rejected: it turns the common case into a retry loop, and an
agent that loses a race would have to re-read and re-reason about the whole list
rather than just saying "add this".

**CRDTs / operational transform.** Correct under any concurrency, no conflicts
ever. Rejected as wildly disproportionate: this is a handful of short text lists,
not a collaborative document. Phase I's richer documents may revisit it.

**Store artifacts by filename.** Simpler paths, human-readable on disk. Rejected:
two people uploading `notes.md` then silently overwrite each other, which is the
same lost-update failure this ADR exists to remove.
