# 0020 — LaTeX compiles in the browser, never on the server

**Status:** Proposed
**Date:** 2026-10-01

## Context

The `latex` output kind (M13) is for academics and students writing papers with
agents and each other. Its value is the loop *edit source → see the PDF change*,
so the PDF has to be compiled continuously while people work.

LaTeX is a programming language with filesystem and process access:

- `\write18{…}` runs a shell command when shell-escape is enabled, and some
  distributions enable a "restricted" list by default.
- `\input{/etc/passwd}` and `\openin` read arbitrary files the process can see.
- A loop in a macro runs until something kills it.

In a session, the source is written by every member **and their agents** — that is,
by untrusted input (`docs/security.md`, Threat 1). A server that runs `pdflatex` on
it is a remote execution service whose inputs any invited member, or any document an
agent was persuaded to write, controls. ADR 0014 refused to let database rows launch
stdio processes for exactly this reason; compiling TeX on the server would undo that
decision through a side door.

## Decision

**The PDF is compiled in each viewer's browser by a WebAssembly TeX engine in a Web
Worker. The server stores and syncs source; it never runs a TeX engine.**

- The engine's virtual filesystem contains the output's files and the session's
  artifacts mounted by name, so `\includegraphics{figure1.png}` finds an uploaded
  figure. Nothing else from the viewer's disk or the server is reachable.
- Compilation is debounced on edit and runs in a worker, so a runaway document
  stalls one tab's preview, not the editor and not the server. The worker is killed
  and restarted after a timeout.
- TeX packages are fetched on demand from a package host. The default is one the
  **instance serves itself** (see `docs/operations.md`), so a self-hosted instance
  does not tell a third party which packages its documents use.

### Agents still learn whether the build broke

The server cannot compile, but an agent editing `main.tex` needs to know whether
its edit broke the build. A viewer's browser reports the result of each compile —
the version compiled, ok or failed, and the first errors with line numbers — and
`read_output` returns the latest report:

```jsonc
"build": { "status": "failed", "version": 42, "at": "…",
           "errors": [{ "file": "main.tex", "line": 118, "message": "Undefined control sequence" }] }
```

With nobody viewing, `status` is `unknown`, and the agent is told so rather than
told it passed. Agents that have a local TeX install can always compile for
themselves; this is for the ones that cannot.

A build report comes from a member's browser, so it is trusted only as much as a
member is: it is display data and a hint to the agent, never an input to any
permission decision.

### Choose the engine by running it

Two candidates exist, and the milestone starts by installing both and compiling a
real paper, not by reading their READMEs (the lesson of Codex at M5 and Cursor at
M16):

| Engine | Shape | Question to answer |
| --- | --- | --- |
| SwiftLaTeX | pdfTeX / XeTeX in WASM, packages fetched on demand | Can its package server be self-hosted simply? |
| BusyTeX | TeX Live tools in WASM, packages bundled as data files | How large is the download, and does it run BibTeX/Biber? |

The bar: an article using `amsmath`, `graphicx`, `hyperref` and a `.bib`
bibliography compiles in under ten seconds on a laptop, cold, and in under two warm.

## Consequences

- No server-side attack surface from TeX at all. The worst a hostile document can do
  is hang the preview tab of someone who opened it.
- Every viewer compiles independently. Three people viewing a paper means three
  compiles; that is their CPU, not ours, and it scales with viewers, not sessions.
- The first open downloads an engine of several megabytes and then packages.
  Subsequent opens are cached. This is slower than Overleaf's first open; it is the
  price of running nothing on the server.
- Build status depends on someone having the output open. Agents can be told this
  plainly; they cannot be told something we did not observe.
- Desktop (M9) inherits it unchanged — the Tauri webview runs WASM.
- Whatever the engine cannot do (some packages, shell-escape-dependent tools like
  `minted`) is unavailable. That is a feature restriction stated in the docs, not a
  bug to work around with a server fallback.

## Alternatives considered

**Compile on the server in a sandbox** (container, `-no-shell-escape`, read-only
FS, CPU and time limits). The Overleaf approach, and it gives the server
authoritative build status. Rejected: it makes the server a code-execution host for
untrusted input, it needs container infrastructure a self-hoster does not have, and
"sandboxed correctly" is a claim that has to be re-proved every TeX Live release.

**Compile on the agent owner's machine via the runner.** The runner already runs
local processes with consent (ADR 0011). Rejected: a document is the session's, not
one member's, and it would compile only when a runner is up; and it would make the
runner execute other members' input, which ADR 0011's consent does not cover.

**Integrate Overleaf instead.** Academics already use it. Rejected for now: its
programmatic access is a git bridge on paid plans, there is no edit API agents could
use live, and it is a natural later adapter once the contract exists.

**Render with a JavaScript LaTeX-to-HTML converter** (latex.js and similar).
Instant and tiny. Rejected: it supports a subset of LaTeX and produces HTML, not
the PDF the paper will be submitted as; people need to see what they will submit.
