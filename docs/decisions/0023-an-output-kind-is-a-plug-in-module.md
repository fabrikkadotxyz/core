# 0023 — An output kind is a plug-in module

**Status:** Accepted
**Date:** 2026-10-03

## Context

ADR 0019 put every output kind "behind one adapter contract" (`create`, `read`,
`edit`, `changes`, `render`), and the contract is what lets agents use four tools
whatever the kind. The **agent-facing** half of that holds. The **code** half was
never built. By M13 the "adapter" was a `KINDS` table holding a name, a template and
an `available()` flag, and everything else was one Yjs implementation with the
second kind threaded through it:

| Where | What knows about `latex` |
| --- | --- |
| `server/outputs.ts` | rename rewrites `\title{}`; build reports accepted and served; file-name rules are TeX extensions |
| `server/mcp.ts` | `format: kind === 'latex' ? 'latex' : 'markdown'` |
| `server/index.ts` | `/tex-assets/*` and `/tex` routes |
| `db/schema.ts` | `outputs.build` column; `outputs.external_ref` waiting for `gdoc` |
| `types` | `OutputKind = 'doc' \| 'latex'` |
| `web/Outputs.tsx` | default name, icon per kind |
| `web/OutputView.tsx` | `isLatex` picks the body and the tab labels |
| `web/SessionPage.tsx` | which tab "Show me" opens |

Adding `latex` meant touching eight files across four packages. M14's `gdoc` is
worse than `latex`: its content lives in Google, not in a Yjs document, so it
cannot even be threaded through, because `editOutput` assumes a hub. Every kind
after that (slides, sheets, whatever the catalogue grows into) would pay the same
cost, and every one of them would risk breaking the others.

ADR 0019's catalogue is described as "the seed of a marketplace". A seed that
needs core edits for every new entry isn't one.

## Decision

**An output kind is one folder on the server and one folder on the web client,
each registered by one line. Nothing outside those folders names a kind.**

```
apps/server/src/outputs/
  core.ts            catalogue, create/list/rename/delete, routing to kinds
  contract.ts        OutputKindModule, OutputStore
  changes.ts         the attributed changes log, shared by every store
  yjs-store.ts       the native store: Yjs hubs, sync socket, persistence
  registry.ts        export const KINDS = [doc, latex]          ← one line per kind
  kinds/doc/         index.ts
  kinds/latex/       index.ts, tex-assets.ts

apps/web/src/outputs/
  OutputView.tsx     shared chrome: title, presence, tabs, delete
  kinds/registry.ts  export const WEB_KINDS = { doc, latex }     ← one line per kind
  kinds/doc/         index.ts, DocBody.tsx
  kinds/latex/       index.ts, LatexBody.tsx, compiler.ts, …
```

### Two layers on the server: a kind, and the store it uses

A **store** owns where content lives and how edits are applied: `read`, `edit`,
`files`, `addFile` / `removeFile`, the browser `attach`, and `version`. A
**kind** owns what the content means. `doc` and `latex` share the Yjs store;
`gdoc` brings a Google store. So a new kind on native storage is mostly metadata,
and a new storage backend doesn't touch the kinds that don't use it.

A kind module declares:

| Field | Purpose |
| --- | --- |
| `id`, `name`, `description`, `icon`, `defaultName` | The catalogue entry, sent to clients. The UI never hardcodes them |
| `format` | What `read_output` reports as `format` (`markdown`, `latex`, …) |
| `multiFile`, `mainFile`, `acceptsFile(path)` | The file model. Path rules are the kind's, not core's |
| `available()` | Absent, not broken, when the instance lacks what the kind needs |
| `store` | Which store holds its content |
| `template(name)` | The files a new output starts with |
| `onRenamed?` | React to a rename (latex keeps `\title{}` in step) |
| `readExtras?` | Extra fields for `read_output` (latex's `build`) |
| `onClientMessage?` | Text frames from a viewer's socket (latex's `build.report`) |
| `routes?` | HTTP routes the kind needs, public or session-scoped (latex's TeX assets) |
| `agentHint?` | One sentence appended to the `edit_output` description |

Hooks get a narrow **context** (the output's id, session, version, file text,
viewer count, the kind's own data, and an `edit` function that goes through the
same attributed path as everyone else), not the database or the hub. A kind can't
bypass the changes log, because it has no other way to write.

### Kind-owned data is opaque to core

`outputs.build` and `outputs.external_ref` become one column, `kind_data jsonb`,
that core stores and never reads. Latex keeps its build report there, and `gdoc`
will keep its Google file id there. A new kind needs no migration to remember
something about itself.

### The web client: shared chrome, one lazily loaded body

`OutputView` renders what every kind has: the title, presence, the tab strip,
History and delete. A web kind module provides tab labels, which tab "Show me"
opens for an edit, and a **lazily loaded body** component. The TeX engine stays a
cost only papers pay.

A kind the server offers but the client has no module for gets a **generic text
body**: a collaborative editor and History. A server-only kind is therefore
usable, if plain, and the web module is an improvement, not a prerequisite.

### Enforced, not hoped for

A unit test scans `apps/server/src` and `apps/web/src` outside `outputs/kinds/`
and the two registries, and fails if any file names a registered kind id as a
string literal. Decoupling that isn't checked erodes one convenient `if` at a
time, which is exactly how M13 got here.

### What does not change

- **The agent-facing contract.** The MCP tools, their arguments, their results,
  the error codes and `build` are unchanged. This is a refactor underneath
  `docs/protocol.md`, not a change to it. The M12 and M13 acceptance checks must
  pass unmodified.
- **Built-ins only.** ADR 0019's rule stands: a kind is code that runs beside
  credentials, so only this repository adds kinds. This ADR makes adding one
  cheap. It doesn't make loading someone else's safe.

## Consequences

- **Adding a kind touches its two folders, the two registry lines, and its docs.**
  M14 is the first test: the `gdoc` change must touch nothing else in `apps/`,
  apart from the generic Google connection, which is a per-user integration and
  not part of the kind.
- `OutputKind` becomes `string`. The catalogue, not the type system, is the list
  of kinds, because the instance decides at runtime which kinds are available.
- One migration: `kind_data` replaces `build` and `external_ref`, carrying
  existing build reports across.
- Store-level behavior (anchored edits, attribution, version, the changes log) is
  written once per store. The Google store must re-implement anchored edits
  against the Docs API (ADR 0021). That cost is real and is why stores are a
  separate layer from kinds.
- A kind's hooks run inside the server process with the access the context
  gives them. That's adequate for built-ins and is the boundary a third-party
  story would have to harden.

## Alternatives considered

**Keep the `KINDS` table and add `if (kind === …)` as needed.** It's the cheapest
next step for any single kind. Rejected: it's what we have, and `gdoc` can't fit
it, because its storage isn't Yjs.

**One interface, no store layer.** Each kind implements read and edit itself.
Rejected: `doc` and `latex` would duplicate the whole Yjs engine, or share it
through a base class with the same coupling under a different name.

**Auto-discovery** (scan `kinds/` at startup, `import.meta.glob` on the web).
This needs zero registry lines. Rejected: a typed import line costs one line,
makes the set of kinds greppable and type-checked, and doesn't load code just
because a folder exists.

**Kinds as separate workspace packages.** That would give the strongest
isolation. Rejected for now: CLAUDE.md admits a package only with a second
consumer, and a kind has exactly one. Folders with an enforced boundary give the
isolation without the package overhead. If third-party kinds ever happen, that
is the moment to promote them.

**A generic `kind_data` table instead of a column.** Rejected: a kind's data is
one small object per output, read whenever the output is. A column is the right
shape, and a table adds a join for nothing.
