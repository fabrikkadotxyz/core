# 0020 — LaTeX compiles in the browser, never on the server

**Status:** Accepted
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
a hash of the source it compiled, ok or failed, and the first errors with line
numbers — and `read_output` returns the latest report:

```jsonc
"build": { "status": "failed", "version": 42, "at": "…", "viewers": 2,
           "errors": [{ "file": "main.tex", "line": 118, "message": "Undefined control sequence" }] }
```

The browser does not know the server's version counter, so it reports **what it
compiled** as a SHA-256 of the files. The server accepts a report only if that hash
matches the current text, and records it against the current version. A report for
source that has since changed is discarded rather than mislabelled.

If no viewer has compiled the current version, `status` is `unknown`, and the agent
is told so rather than told it passed. `viewers` says how many browsers have the
output open, so an agent can tell "wait two seconds and re-read" from "nobody is
going to compile this". Agents that have a local TeX install can always compile for
themselves; this is for the ones that cannot.

A build report comes from a member's browser, so it is trusted only as much as a
member is: it is display data and a hint to the agent, never an input to any
permission decision.

### Choose the engine by running it

The milestone started by installing the candidates and compiling a real paper, not
by reading their READMEs (the lesson of Codex at M5 and Cursor at M16). The bar: an
article using `amsmath`, `graphicx`, `hyperref` and a `.bib` bibliography compiles
in under ten seconds on a laptop cold, and under two warm.

What running them found (2026-10-01, headless Chrome, Apple silicon):

| Candidate | Result |
| --- | --- |
| **SwiftLaTeX** (2022) | Its engine fetches every package from `texlive2.swiftlatex.com`, which **is down** (Cloudflare 522). Self-hosting means rebuilding its TeX Live tree and a format file matching a 2022 binary. Unmaintained since 2024. Rejected. |
| **BusyTeX** (upstream WASM build, 2024) | A 30 MB engine plus 105 MB of TeX Live data per viewer before the first page. The maintained npm wrapper, `texlyre-busytex`, is **AGPL-3.0**, a copyleft obligation Fabrikka does not take on for a build tool. Rejected. |
| **Siglum** `@siglum/engine` 0.1.4 (MIT, TL 2025) | Compiles fast once loaded, but `hyperref` fails (`hycolor.sty` is not in its bundles) without a separate Bun CTAN-proxy service; **it never runs BibTeX**; and its `blake3-wasm` dependency does not resolve under Vite. Single maintainer, quiet since January. Rejected. |
| **Typeward** `@typeward/texlive-wasm` 0.2.4-alpha (MIT, TL 2026) | pdfLaTeX + BibTeX compile the paper with citations and cross-references resolved, SyncTeX included. **Cold full build 0.94 s, warm full build (pdfLaTeX → BibTeX → pdfLaTeX ×2) 0.56 s, warm single pass 0.19 s.** `\input{/etc/passwd}` finds nothing; `\def\x{\x}\x` is killed by the run timeout. **Chosen.** |

Typeward is pre-alpha with a tiny following, so the choice is hedged:

- **Pinned exactly** (`0.2.4-alpha`, no range), as its own version contract demands.
- **We use only `createEngine` and `run`.** Its `latexmk` driver and its lazy
  long-tail fetch were both found wanting — `latexmk` never retries BibTeX's missing
  `plain.bst`, and lazily fetched files are written but never visible to kpathsea on
  the rerun. So Fabrikka drives the passes itself and handles the long tail itself:
  when TeX reports a missing file, look it up in the full tree's `ls-R`, fetch it
  from the instance, add it to the project directory (which TeX searches first), and
  rerun. About sixty lines, and the whole surface we would have to replace if
  Typeward disappeared.
- **Every asset is served by the instance.** No CDN, no third party learns which
  packages a document uses.

First-open download for a viewer is about 39 MB (engine 0.5 MB, core TeX tree
28 MB, BibTeX 0.4 MB, ICU data 9.7 MB), then cached. Long-tail files are fetched
individually, typically a few kilobytes each.

## Consequences

- No server-side attack surface from TeX at all. The worst a hostile document can do
  is hang the preview tab of someone who opened it.
- Every viewer compiles independently. Three people viewing a paper means three
  compiles; that is their CPU, not ours, and it scales with viewers, not sessions.
- The first open downloads about 39 MB, then packages on demand. Subsequent opens
  are cached. This is slower than Overleaf's first open; it is the price of running
  nothing on the server.
- An instance that offers LaTeX stores about 360 MB of TeX Live assets on disk
  (`pnpm tex:install`). An instance without them simply does not list the kind.
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
