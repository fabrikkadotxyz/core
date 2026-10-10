# Roadmap

Milestones are **sequential**. Each ends in something manually exercisable. Do not start the next one until the current one's test passes.

The MVP answers one question: *does it feel useful to have a private room where I work with my existing agents and other people?*

> **Renumbered 2026-10-01.** Outputs (M12–M14) were inserted before steering.
> Steering was M12 and is now **M15**; four more agents was M13 and is now **M16**.
> Accepted ADRs written before that date use the old numbers.

---

## M0 — One message, end to end

Monorepo, Hono server, Postgres via `docker/`, Drizzle schema for `users` / `sessions` / `participants` / `messages`, WebSocket event bus, React timeline. One hardcoded session, no auth.

**Test:** Open two browser tabs on the same session. Type in one, see it in the other. Refresh — history persists.

## M1 — Auth, real sessions, privacy

**Runs with zero mail configuration** — see [ADR 0007](decisions/0007-email-is-a-transport.md).
Email is a transport for links the system already generates, never a prerequisite.

- Password auth (scrypt from `node:crypto`, no native module) with server-side
  `auth_sessions` so access can be revoked immediately.
- **No open registration.** First account via `pnpm admin create-user --owner`;
  every later account redeems an invite. One code path, not two.
- Session CRUD: create / rename / archive, private by default.
- `session_members` with `owner | member` roles.
- **Invite links**, not invite emails: single-use, 7-day expiry, revocable,
  hashed at rest, optionally scoped to an email address (enforced at redemption,
  so it needs no mail server). UI offers *Copy invite link*.
- Admin CLI: `create-user`, `reset-password`, `list-users`, `delete-user`.
  `reset-password` **is** the password recovery path — there is no emailed link.

**Test:**
1. `pnpm admin create-user --email fede@example.com --owner`, log in as fede.
2. Confirm signup without an invite token is refused.
3. Create a session; rename it; archive it; confirm it's private by default.
4. Create an invite, copy the link, redeem it in a private window as alice.
   Both now see the session.
5. `pnpm admin create-user` a third account, carol, and hit the session URL:
   **404, not 403** — existence is private.
6. Redeem the same invite link again — refused (single use). Revoke a second
   invite before use — refused.
7. Create an invite scoped to `alice@example.com` and try to redeem it as carol
   — refused, with no mail server involved.
8. `pnpm admin reset-password --email alice@example.com`, confirm alice's
   existing login is invalidated immediately.

## M2 — Participants and mentions as first-class

Humans and agents already share the `participants` id space (M0). This milestone
makes **mentions** first-class, per
[ADR 0008](decisions/0008-mentions-as-stable-markers.md).

- `messages.content` stores stable `<@participant_id>` markers; display names
  resolve at read time, so renames are correct retroactively.
- `message_mentions` rows are **derived from the markers** at write time, so
  content and rows cannot drift apart.
- Composer autocomplete on `@`, resolving to a participant id — never a name.
- The write path also resolves bare `@name` in prose, so an agent posting plain
  text over MCP (M3) produces real mentions without knowing internal ids.
- Mentioning a participant from another session is **rejected**, not ignored.
- Participants can be renamed: your own in any session you're in, anyone's if
  you own the session. Per-session display names stay unique.

**Test:**
1. Type `@ali`, pick alice from the dropdown, send. The message renders her as a
   chip.
2. Confirm a `message_mentions` row exists, and that `messages.content` holds a
   `<@…>` marker rather than the literal text `@alice`.
3. **Rename alice to `alicia`. The old message now reads `@alicia`** — the
   mention still resolves to her, retroactively.
4. Post `hey @alicia` as plain text over the API with no `mentions` array; a
   mention row is still created (this is the path agents will use).
5. Try to mention a participant id from a different session — rejected with 400,
   not silently dropped.
6. Rename a participant to a name already taken in that session — rejected.

## M3 — Remote session MCP endpoint (lane A) — *first real payoff*

`/mcp/o/{owner_id}/s/{session_id}` served with `createMcpHandler` on a
`createMcpHonoApp` sub-app. Tools: `whoami`, `get_session_context`,
`update_session_context`, `list_participants`, `read_messages`, `post_message`.

Auth is a **static bearer token scoped to one `(session, participant)` pair** —
see [ADR 0009](decisions/0009-participant-scoped-tokens.md). The token *is* the
agent's identity, so authorship cannot be spoofed by a request body. A missing
credential answers 401; every other failure is a 404.

No OAuth metadata is served yet, deliberately: advertising an authorization
server that does not exist would send clients into a flow that cannot complete.

Adding an agent creates its identity, participant row and first token in one
step, and returns a ready-to-paste `claude mcp add` command. Each message carries
a per-reader `trust` field (`owner` / `session` / `untrusted`) — reported
honestly here, **enforced at M6**.

**Test:**
1. In a session you own, *Agents* → add `claude-fede` → **Copy command**.
2. Paste it in a terminal, then `claude mcp list` — it reports `✔ Connected`.
3. Ask Claude to read the session and post a summary mentioning `@you`. It
   appears in the browser attributed to `@claude-fede`, with your name as a chip
   — the agent wrote prose, the server resolved the mention.
4. Confirm a token for session A returns **404** on session B's URL, and that a
   wrong `owner_id` in the path returns 404.
5. Revoke the token in the UI; the next agent call fails immediately.

## M4 — Bridge CLI + channels (lane B) — *the moment it feels alive*

`packages/bridge` ships the `fabrikka` CLI: a **v1-SDK** stdio MCP server holding
a WebSocket to Fabrikka. Claude Code spawns it from `.mcp.json`; it declares
`experimental['claude/channel']` and pushes `notifications/claude/channel`.

The bridge **proxies** the session's HTTP endpoint rather than reimplementing
tools, so it gains future tools for free and cannot drift from lane A
([ADR 0010](decisions/0010-bridge-proxies-and-gates-at-source.md)). Replying is
`post_message` — there is no separate `reply` tool.

**Delivery is decided by the server, never the bridge.** A channel push starts a
turn, and the bridge runs on the user's machine as a process they can edit, so the
gate belongs upstream. Mention-gated, never its own messages, and `owner_only` by
default — which means the prompt-injection gate lands here, not at M6. M6 adds the
turn budget, the kill switch, and the same gate on the spawn path. A blocked
mention emits `mention.blocked` so a human can see it.

Three details that fail **silently** if missed, all in `docs/protocol.md`:
`meta` keys must be `[A-Za-z0-9_]+`; `MCP_PROTOCOL_NEGOTIATION` must stay unset or
the server is never registered as a channel; and markers must be expanded before
delivery or the model receives `<@uuid>` and cannot tell who was addressed.

**Test** (the push→react step needs an *interactive* session — `claude -p` exits
after one turn, so a channel event arriving mid-turn has no next turn to land on):
1. In a session you own, *Agents* → add `claude-fede` → **Live session** tab.
2. Save the `.mcp.json` into a project directory and start Claude Code there with
   the printed `--dangerously-load-development-channels` command. Accept the
   full-screen warning; confirm the dim startup notice names `server:fabrikka`.
3. Participants shows `@claude-fede` as **connected**.
4. From the browser send `@claude-fede what's in my working directory?`. Claude
   reacts **in your running terminal, with your repo open**, and its answer lands
   back in the browser. This is the demo.
   - The first `post_message` call may raise a permission prompt in the terminal.
     Approve it, or the answer never leaves the machine.
5. Invite a second person and have them mention `@claude-fede`: nothing happens,
   and the timeline says it was not notified because only its owner can direct it.
   Flip the agent to *session trusted* and it goes through.

## M5 — Spawn-on-mention + Codex

`fabrikka watch --dir <project>` registers a **`runner`** connection. When a
mention arrives and no live `bridge` is attached, it spawns a headless run in that
directory and the result lands in the session.

**Spawning is local — the server never does it.** A useful run needs the user's
repo, their agent binary and the credentials it holds; a hosted server has none of
those. Starting the runner **is** the consent for unattended execution: the user
chose the directory, and it prints what it will do before doing anything. See
[ADR 0011](decisions/0011-spawning-is-local-and-opt-in.md).

- `claude -p … --mcp-config … --dangerously-skip-permissions`, and
  `codex exec … --approve-for-me` for Codex (which, unlike Claude Code's
  headless mode, runs inside a workspace-write sandbox).
- Each run gets a **run-scoped token**: same session and participant, 30-minute
  TTL, revoked when the run ends.
- One run at a time per agent; further mentions queue to a cap and are then
  dropped with a note in the session rather than silently.
- **If the agent posts nothing, the runner posts the final text for it** — the M4
  lesson: a silent run is indistinguishable from a broken one.
- The delivery gate (ADR 0010) is unchanged and still server-side, so only
  authorised mentions can start a run.

**Test:**
1. Quit any live Claude Code session for the agent, so no `bridge` is attached.
2. `fabrikka watch --dir ~/some/project` — read the banner it prints.
3. Participants shows the agent **connected**.
4. Mention `@claude-fede` from the browser. A run starts, the pill goes
   **working → idle**, and its answer appears in the timeline.
5. Have a non-owner mention it: nothing runs, and the timeline says why.
6. Start a live Claude Code session as well. The next mention goes to the **live
   session**, not a spawned run — `bridge` wins over `runner`.

## M6 — Safety rails — *gate, not a suggestion*

> **M6 must land before a second human is ever put in a session with a spawn-enabled agent.**

Two of these landed early, at M4, because the delivery function was the natural
place for them:

- ✅ `trust_tier` default `owner_only` — only the owner's mentions trigger action.
- ✅ Mention-gated delivery; an agent never receives its own messages.
- ✅ Blocked mentions surface as `mention.blocked` rather than vanishing.

M6 adds the rest:

- **Turn budget** — 20 deliveries per 10 minutes **per session**, then the session
  pauses. Per session, not per agent: two agents each under their own cap still
  loop forever.
- **Kill switch** — one control, reached manually or by the budget.
- Honest limits, stated in the UI rather than implied
  ([ADR 0012](decisions/0012-halt-is-server-side-termination-is-cooperative.md)):
  halting delivery is **absolute**, aborting a spawned run is **cooperative**, and
  a live channel turn **cannot be recalled at all**.

**Test:**
1. Alice mentions `@claude-fede`. It does not act; the timeline says why. *(M4)*
2. Point two agents at each other and watch the budget halt the loop. The session
   shows as paused, with the reason, and says so in the timeline.
3. Resume. Delivery works again.
4. Start a long spawned run, hit the kill switch: the child process dies and the
   run reports being stopped.
5. Hit it with a live Claude Code session mid-turn: that turn finishes. The UI
   already told you it would.

## M7 — Session context UI + artifacts

The context tools and storage landed at M3, so this is the human half plus
artifacts — and one correctness fix that matters more than either.

- **Context is append-first.** `add_facts` / `remove_facts`, with wholesale
  replacement requiring the `version` you read. Patch semantics as shipped at M3
  let an agent writing back "the complete list" silently delete what a human typed
  a minute earlier ([ADR 0013](decisions/0013-context-is-append-only-with-explicit-removal.md)).
- Context editable in the browser.
- **Artifacts**: file upload and links, with `list_artifacts`, `read_artifact` and
  `create_artifact` — an agent producing `investigation.md` is the point.
- Files are stored by **content hash**, so two people uploading `notes.md` do not
  overwrite each other.

**Test:**
1. Write an Objective in the browser; an agent reads it over MCP without being
   told it exists.
2. The agent appends a Decision with `add_decisions`; it appears in the browser
   without displacing anything.
3. **The one that matters:** type a fact in the browser, and *while it is
   unsaved*, have the agent add one. Both survive.
4. Upload a CSV; the agent lists and reads it.
5. The agent creates an artifact; it appears in the browser.
6. Upload two different files both called `notes.md`. Both exist, neither
   clobbers the other.

## M8 — MCP aggregation (per-participant credentials)

Members attach their own external MCP servers; the session endpoint proxies them
with namespaced names (`github__create_issue`), routing every call to the
**calling participant's** credential.

- **HTTP servers only.** A command-launched stdio server would make this server an
  arbitrary-command executor driven by database rows; local servers belong to the
  bridge ([ADR 0014](decisions/0014-aggregation-is-http-only-and-credentials-are-encrypted.md)).
- **Credentials are encrypted at rest** under an operator key, and attaching one
  **fails** if no key is configured — unavailable beats insecure.
- **Grants are per session, per tool, default deny**, keyed by the integration's
  slug rather than by whose row it is.
- A server a participant has not attached is **absent** from their tool list, not
  present-and-denied, which would leak the session's topology.

**Test:**
1. Set `FABRIKKA_ENCRYPTION_KEY`, attach an integration with a token.
2. Grant one tool. It appears namespaced in the agent's tool list; the ungranted
   ones do not.
3. Alice, who has not attached it, does not see the tools at all.
4. Alice attaches her own credential; her calls go upstream with **her** token.
5. Revoke the grant — the tool disappears from the list.
6. Unset the key and try to attach: refused, not stored in plaintext.

## M9 — Tauri desktop

A deliberately thin shell around the same web app. Sequenced last because at MVP
it adds no product surface, and the things desktop uniquely enables — local MCP
servers, local files, local-only sessions — are Phase II.

- Tauri 2 shell that remembers which server to talk to (`FABRIKKA_URL` wins, else
  a first-run page, else a saved config file). Only `http(s)` is accepted.
- **The server now serves the built web app**, so one origin carries the UI, the
  API, the MCP endpoint and the bridge. Without that the desktop app points at an
  API with no interface — which is exactly how this gap was found.
- macOS `.app` built and verified here. Windows and Linux targets are configured
  but **not built or signed on this machine**; that needs CI on each platform.

**Test:**
1. `pnpm --filter @fabrikka/web build`, then open `http://localhost:9090` — the
   UI is served by the server itself, not Vite.
2. Launch `Fabrikka.app`. First run asks for the server; enter it once.
3. Sign in, open a session, confirm realtime messaging behaves as in the browser.
4. Relaunch — it goes straight to the session, remembering the server.

## M10 — Live activity: watch it work

> The multiplayer claim is "drop into a live agent session to **watch it work**,
> redirect it, and hand it off." Today a session shows a `working` pill and
> nothing else: every tool call goes to `console.error` on the runner's machine.
> The work happens off-screen, which is the read-only-transcript problem one level
> in. This is the milestone that makes the claim true.

**Cheapest of the three gaps, because the events already exist** — `onLog` fires on
every tool call, the event bus already fans out, the browser already has a socket.
They are pointed at stderr instead of the session.

- A **`run`** is addressable: id, agent, trigger message, started/ended, outcome.
  Required here, and a prerequisite for M15 (steering).
- Activity streams into the timeline as it happens: `Read src/retry.ts`,
  `Bash ran the test suite`, `github__list_issues`.
- **Summary, never transcript** ([ADR 0015](decisions/0015-activity-is-a-redacted-summary.md)):
  tool name plus one short redacted descriptor. **Never tool output**, never full
  command lines. Redaction happens **on the runner, before the wire** — the only
  place it stops a secret travelling at all.
- **Ephemeral**, capped per run (~200 events), so a late joiner catches up without
  leaving hundreds of rows behind forever. The run's *outcome* is a durable message.
- The agent's **owner can turn it off** per session. Streaming your activity to a
  shared room is a fair default and an unfair obligation.
- Activity is **inert display data**: never delivered to another agent, never
  counted against the turn budget. It must not become an injection path.

**What shipped**

- `runs` is a table; `run.start` / `activity` / `run.end` are bridge frames, and
  `run.started` / `activity` / `run.ended` are browser events
  ([docs/protocol.md](protocol.md)).
- Redaction lives in `packages/bridge/src/redact.ts` and runs before the wire.
  `Bash` reports its **first token only**, `WebFetch` a hostname, an unknown tool
  its name and nothing else. 30 unit cases, `pnpm test`.
- The runner parses the agent's stream **incrementally**. It first buffered stdout
  and parsed on exit, which replayed the whole run *after* the answer — every
  content assertion passed and the feature was useless.
- Frames from one connection are handled **one at a time**; concurrent handling
  published `post_message` before the `Read` it was based on.
- Catch-up rides on the stream's `hello`: in-flight runs plus their buffered steps.
- Per-agent `steps shown / steps hidden` toggle in the Agents panel, owner only.

**Test:**
1. Start a runner, mention the agent, and watch the timeline from a *second*
   browser — steps appear as they happen, not at the end.
2. Join mid-run in a third tab: you catch up on the current run.
3. Have the agent run `Bash(curl -H "Authorization: Bearer sk-test-123" …)`. The
   timeline shows the tool ran; **the token does not appear**.
4. No tool output ever appears in the timeline.
5. Turn activity off for that agent; the pill still moves, the steps stop.
6. A second agent in the session never receives activity as context.

## M11 — The session screen: configure, converse, produce

> Every panel the last eight milestones added went into one right-hand column:
> participants, members, invites, integrations, context, artifacts, agents,
> tokens, settings. It is a **stack of nine panels next to a chat**, and the
> chat — the thing people are actually here for — is the narrower half of the
> screen. The information architecture never got designed; it accumulated.

Three panes, each answering a different question
([ADR 0018](decisions/0018-session-screen-is-three-panes.md)):

| Pane | Question | Holds |
| --- | --- | --- |
| **Left — Setup** | *Who and what is in this session?* | Participants, members, invites, agents, integrations, tokens, session settings |
| **Middle — Conversation** | *What are we saying?* | Timeline, activity, composer. **Never collapses** |
| **Right — Output** | *What has this session produced?* | Session context (objective, decisions, facts, questions, constraints) and artifacts |

- The left rail **collapses**, because setup is what you do once and conversation
  is what you do for an hour. Collapsed state is remembered per session.
- The middle pane is the one that grows when either side closes. It is the product.
- The **right rail is resizable**, by dragging its inner edge. Output is the pane
  whose content varies most — an objective is two lines, a decision log is thirty —
  so one fixed width is wrong for somebody. Width is clamped (260–640px, and never
  past 60% of the window), remembered per session beside the collapsed state, and
  **adjustable from the keyboard**: the handle is a focusable `separator`, arrow
  keys move it, Home/End go to the limits, double-click resets. A resizer only a
  mouse can reach is a control half the users do not have.
- The right pane is **what the session produced**, which today means context and
  artifacts — both already real (M7). It is deliberately *not* a placeholder for a
  generate button: a pane that exists to be filled later is a pane that teaches
  people to ignore that third of the screen.
- **A member can add their own agent from the UI.** The server has allowed this
  since M3's fix; the web app still gated the panel on `isOwner`, so `@claude-alice`
  was impossible to create through the interface. The restyle is where that shows.
- No new API surface. This milestone moves and styles what exists; the one
  behavioural change is the gate above.

**Test:**
1. Open a session. Three panes: setup on the left, conversation in the middle,
   output on the right. The conversation is the widest.
2. Collapse the left rail — the conversation grows. Reload: still collapsed.
   Collapse the right pane too, reload, and both stay as you left them.
3. Drag the right rail's inner edge: it resizes, the conversation gives up the
   width, and the new width survives a reload. Drag it past either limit and it
   stops. Tab to the handle and use ← →, then Home and End; double-click resets it.
4. Post a message with the rail collapsed; the composer and timeline still work.
5. Write an Objective in the right pane; it appears there, not in a panel you had
   to scroll to find.
6. Sign in as a **member** (not the owner): add an agent named `claude-alice`,
   copy its setup block, and connect it. Owner-only controls (invites, tokens,
   delete session) are absent, not broken.
7. Narrow the window to a phone width: the panes stack, conversation first, and
   nothing is clipped or unreachable.
8. Activity still streams into the middle pane while the rail is collapsed.

## M12 — Outputs: work on the document, not about it

> The right pane holds what the session produced, and none of it can be *worked
> on*. Context is lists of sentences; artifacts are immutable. A group writing a
> report talks about the report in the chat and edits it somewhere else. The
> people this is for next — students, academics, office teams — are exactly the
> people whose work is a shared document.

An **output** is a live document that every member and their agents edit at the
same time, with every change attributed. Kinds sit behind one adapter contract, so
agents see the same four tools whatever the kind
([ADR 0019](decisions/0019-outputs-are-live-documents-behind-adapters.md)). This
milestone builds the contract, the catalogue and the first kind, **`doc`**: a
native Markdown document that needs no account and no setup.

- **Agents edit by anchor.** `edit_output` takes `{ old_text, new_text }` pairs;
  each `old_text` must occur exactly once when the edit lands. A human typing in
  another paragraph does not invalidate it; a human rewriting the quoted sentence
  does. Wholesale replace needs `if_version` (the ADR 0013 rule).
- **Humans co-edit in real time.** Yjs over a per-output WebSocket, cursors with
  names. An agent's edit is applied server-side as one more editor, so it merges
  with typing in flight instead of racing it.
- **Every change is attributed** in a durable changes log: who, which run, +/−
  lines, the diff. Human typing coalesces after ten seconds idle.
- **The timeline shows edits as display-only frames** — *claude-alice edited
  Report (+12 −3)* — never as messages. An edit wakes no agent and costs no turn
  budget. To get an agent to react to a document, mention it.
- **Add output** in the right pane lists the kinds this instance has — the
  catalogue, and the seed of a marketplace. Built-in kinds only; third-party
  adapters are not in scope.
- Opening an output widens the right pane; closing restores the viewer's width.
  A document has its own width, resizable like the rail, and the 640px cap lifts
  while one is open (60% of the window remains the limit). The conversation never
  collapses.
- **Easy to understand, easy to manipulate.** The bar is someone who has never
  seen Fabrikka or Markdown:
  - **One click to start**: *+ New document* creates and opens it with the name
    selected, ready to type over — no dialog first. A new document is empty; its
    name is its title.
  - A **formatting toolbar** (bold, italic, headings, lists, quote, link, code),
    with ⌘B / ⌘I / ⌘K. Markdown is underneath, for agents; nobody has to know it.
  - **Edit · Preview · History** tabs. Other people's **cursors carry their names**,
    and who else is in the document shows as avatars.
  - A **Live** badge says changes are saved and shared as you type; there is no
    save button to forget.
  - When an agent edits the document you are looking at, a notice says so with
    **Show me**, which opens that exact change.
  - Only **agent** edits appear in the conversation. Human typing is in History,
    so a person writing for an hour does not flood the timeline.
- The editor loads on first open, so the session screen does not pay for it.

**Test:**
1. Create a `doc` output named *Report* from **Add output**. It appears first in the
   right pane.
2. Two browsers, two members, typing in the same paragraph at once. Both see each
   other's text and cursors live; reload either one and nothing is lost.
3. An agent calls `list_outputs`, `read_output`, then `edit_output` with an anchor
   from a paragraph *while a human is typing in a different one*. Both changes
   survive.
4. Have the agent quote a sentence a human has just rewritten: it gets
   `anchor_not_found` and the document is unchanged. Two edits in one call where
   the second anchor is missing: neither applies.
5. Wholesale replace without `if_version` is refused; with a stale one, refused.
6. The timeline shows *claude-… edited Report (+n −m)*; clicking it shows the
   diff. No agent was woken by it and the turn budget did not move.
7. The changes view lists the agent's edit and the humans' coalesced edits, each
   attributed to the right participant.
8. A non-member's socket to the output is refused exactly like the session stream.

## M13 — LaTeX: see the paper change as they change it

A **`latex`** output: source files with a live PDF beside them, built for papers
written by several people and their agents. Same CRDT and editor as `doc`; the new
part is compilation, which happens **in the viewer's browser and never on the
server** ([ADR 0020](decisions/0020-latex-compiles-in-the-browser.md)) — TeX is a
programming language, and its source here is written by untrusted input.

- **Choose the engine by running it.** Done: four candidates compiled a real paper;
  Typeward's `texlive-wasm` (TeX Live 2026, MIT) passed — cold 0.9 s, warm 0.6 s for
  the full pdfLaTeX → BibTeX → pdfLaTeX ×2 build — and the others did not. Pinned
  exactly; Fabrikka drives the passes and the long-tail fetch itself. See ADR 0020.
- Every TeX asset is **served by the instance** (`/tex-assets/`, installed with
  `pnpm tex:install`). Without them, `latex` is absent from the catalogue.
- Multiple files (`main.tex`, `refs.bib`, sections). Appending to a file that does
  not exist creates it. Session artifacts are mounted by name so
  `\includegraphics{figure1.png}` finds an upload.
- Compiles debounce on edit and run in a Web Worker with a timeout.
- **Agents learn whether they broke the build**: a viewer's browser reports each
  compile, and `read_output` returns `build: { status, version, errors }` — or
  `unknown` when nobody is viewing, never a guess.
- **See what changed**: the changes view highlights each edit in the source; after
  an agent edit the preview scrolls to the page it touched (via SyncTeX, if the
  chosen engine emits it — stated either way).
- **Easy to understand, easy to manipulate**, same bar as M12:
  - A new paper starts from a working template (title, author, a section, a
    citation and `refs.bib`), so the first thing anyone sees is a PDF, not an error.
  - **Source · PDF · History** tabs, a file strip (`main.tex`, `refs.bib`, *+ file*),
    and a LaTeX toolbar (bold, italic, section, list, equation, cite, figure) for
    people who do not know the commands.
  - One status line always says where the build is: *Building…*, *✓ Up to date*,
    or *✗ Line 12: Undefined control sequence* — click it to jump to the line, which
    is marked in the editor.
  - When an agent edits the paper you are viewing, **Show me** opens the PDF at the
    page it changed, with the changed region outlined.

**Test:**
1. Create a `latex` output from the catalogue; a template compiles and the PDF
   appears in the pane.
2. Upload `figure1.png` as an artifact and `\includegraphics` it: it renders.
3. A member edits a sentence; the PDF updates within a couple of seconds. A second
   member, watching, sees the same change.
4. An agent introduces `\undefinedmacro`. `read_output` returns `build.status:
   failed` with the line. It fixes it; the next read says `ok`.
5. Close every browser; `read_output` reports `build.status: unknown`.
6. `\input{/etc/passwd}` and `\write18{touch /tmp/pwned}` do nothing outside the
   tab: nothing is read, nothing runs, on the server or the viewer's machine.
7. `\def\x{\x}\x` hangs only that preview; the editor stays responsive and the
   worker is restarted.

## M14 — Google Docs: meet teams where they already write

A **`gdoc`** output: a Google Doc that the team edits in Google Docs as usual and
that agents edit through the session. Writes go through **the editor's own Google
account** — a member's own, and an agent's owner's
([ADR 0021](decisions/0021-google-docs-writes-use-the-editors-own-account.md)).

> **Verify before building**, the way M16 verifies Cursor. Three claims come from
> documentation, not use: a `drive.file` token can write a doc shared with you
> after one Picker click; anchored edits map onto the Docs API with
> `requiredRevisionId`; and whether the editor can be embedded or only previewed.
> Run each against a real account first.

- **First, output kinds become plug-in modules**
  ([ADR 0023](decisions/0023-an-output-kind-is-a-plug-in-module.md)). `doc` and
  `latex` move behind the kind and store contracts with no change agents can
  see: M12's and M13's acceptance checks pass unmodified. `gdoc` is then the first
  kind **added** that way. Its code lives in its two `kinds/gdoc/` folders and two
  registry lines. The Google connection in Setup is a per-user integration, not
  part of the kind.
- Members connect Google from Setup; tokens are sealed under
  `FABRIKKA_ENCRYPTION_KEY` and connecting is refused without it.
- Scope is `drive.file` only — never the whole Drive.
- `claude-alice`'s edits land as Alice in Google's revision history and as
  `claude-alice` in ours.
- **Reads** fall back to the creator's credential so a member without Google can
  still see the doc; **writes never borrow**.
- Edits made directly in Google Docs are polled while the output is open and
  appear in the changes log, attributed per revision.
- Agents write plain text; the docs say so.
- An instance with no Google OAuth client configured does not list `gdoc` at all.

**Test:**
1. Fede connects Google and creates a `gdoc` output; the doc exists in Fede's Drive
   and is shared with members who have connected.
2. `claude-fede` edits it with an anchor. Google's revision history shows Fede; the
   changes log shows `claude-fede` and the run.
3. Alice edits the doc **in Google Docs directly**; within the poll interval the pane
   updates and the changes log shows an edit by Alice's Google account.
4. Alice's agent edits it: the write goes out with Alice's token, not Fede's.
5. Bob, with no Google connected: he sees the doc, and his agent's `edit_output`
   gets `credential_missing` and changes nothing.
6. Unset `FABRIKKA_ENCRYPTION_KEY` and try to connect Google: refused, nothing
   stored.
7. Remove the OAuth client config and restart: `gdoc` is absent from **Add output**.
8. The diff that adds `gdoc` (everything after the plug-in refactor commit),
   limited to `apps/`: its changes are confined to `outputs/kinds/gdoc/` on each
   side, the two registries and the Google connection. The kind-literal test
   passes.

## M15 — Steering: redirect it

> Today a mention arriving mid-run **queues a second run**, so the agent spends
> minutes finishing work everyone can already see is wrong.

**The honest version is narrower than the word suggests.** Neither runtime lets us
change a model's instructions mid-thought: `claude -p` and `codex exec` take their
prompt up front, and a channel push is documented to land "on the next turn". So
steering **stops and resumes**, and the UI says which
([ADR 0016](decisions/0016-steering-is-stop-and-resume.md)).

| Path | What happens |
| --- | --- |
| Spawned run | Stop the child, restart with `--resume` so the thread survives, carrying the correction |
| Codex spawned run | Starts **fresh** — `codex exec resume` rejects `--approve-for-me` (found at M5). Stated in the UI |
| Live Claude Code session | The correction lands **on the next turn**. No stop: that turn is in the user's own terminal, against their files |

- Steering routes through the **existing delivery gate** unchanged — an untrusted
  mention cannot steer any more than it can start a run. Stopping work in flight is
  more disruptive than starting it, so it cannot be the weaker permission.
- The **kill switch stays open to any member**: stopping everything is safety,
  redirecting is participation.
- Corrections within a couple of seconds **coalesce**, or steering thrashes.
- Each resumed run counts against the turn budget, so a steering war pauses the
  session. Correct, and needs no special case.

**Test:**
1. Start a long spawned run, then mention a correction. The run stops and restarts
   with the correction, and the timeline shows it resumed rather than started over.
2. The new run does not repeat the reading the first one already did.
3. Steer a Codex run: it restarts fresh, and the timeline says so.
4. Steer a live Claude Code session: the timeline says it will be picked up when
   the current turn finishes — and it is.
5. A non-owner correction is refused, exactly like a mention.
6. Fire five corrections in two seconds: they coalesce into one restart.

## M16 — Four more agents, and model pass-through

> **Adding an agent is mostly free already.** Lane A (any MCP client) works today
> for anything speaking MCP — zero code. An adapter buys only the **spawn path**,
> and that is ~50 lines, as Codex was. We do not need twenty-five adapters;
> a runtime-owning approach needs them because it supervises every agent CLI
> ([ADR 0002](decisions/0002-do-not-own-the-agent-runtime.md)).

Ranked by adoption × spawn feasibility, not by name recognition:

| # | Agent | Why it earns the slot | Spawn readiness |
| --- | --- | --- | --- |
| 1 | **Antigravity CLI** (`agy`) | Google's terminal agent for individuals, and Google's distribution — most users per unit of work | `agy -p` ✓, `--dangerously-skip-permissions` ✓, MCP ✓; remote (streamable-HTTP) MCP, output format and resume — **verify first** |
| 2 | **OpenCode** | Widely used open-source agent, and the most-starred one | `opencode run -m provider/model` ✓, MCP ✓, `--attach` skips MCP cold-boot |
| 3 | **Cursor CLI** | Most broadly adopted overall among individuals and small teams | `agent -p` ✓, MCP shares the editor's config — **but verify first** |
| 4 | **Goose** *or* **Copilot CLI** | Goose is MCP-native, so least work and closest to the architecture. Copilot CLI has the widest distribution. Pick by whether slot 4 is about proving the bet or reach | Unverified |

> **Slot 1 changed on 2026-10-07: Antigravity CLI replaces Gemini CLI.** Since
> 2026-06-18, Gemini CLI refuses personal Google sign-ins (free, AI Pro and AI
> Ultra: *"This client is no longer supported for Gemini Code Assist for
> individuals"*). It keeps working only on a Gemini API key or a paid Code Assist
> Standard/Enterprise license, so the free tier that earned it the slot is gone.
> Google sends individuals to the Antigravity CLI instead. **Verify it before
> building**, as for Cursor: three things the spawn path needs aren't confirmed by
> its documentation, namely a remote MCP server from a config passed per run, a
> machine-readable output stream, and resuming a run (M15 steering resumes). A
> Gemini CLI adapter on an API key stays possible later; it is no longer slot 1.

> **Verify Cursor before committing.** There is an open Cursor request titled *MCP
> access in headless mode*. If MCP does not work under `-p`, a spawned Cursor run
> cannot reach the session endpoint and falls back to relay-only — the same
> asymmetry Codex appeared to have until it was actually installed and tested, at
> which point three documented claims turned out to be wrong. Install it, run it,
> then decide.

Not on the list, deliberately: **Cursor IDE, the Antigravity IDE, Cline,
Windsurf.** IDEs and extensions with no headless CLI of their own (the Antigravity
CLI is slot 1 and ships separately from the IDE). They get Lane A today and need nothing from us.

### Model pass-through

See [ADR 0017](decisions/0017-model-selection-is-spawn-only.md). The short version
is that we mostly cannot choose, and the interface says so:

| Lane | Model chosen by |
| --- | --- |
| Live session | The user, when they started their agent |
| Any MCP client | The user, in their own client config |
| **Spawned run** | **Us** — we build the command line |

- Optional `model` per session-agent, null meaning the agent's own default, passed
  as `--model` / `-m` on spawn and ignored elsewhere.
- **Opaque string, no curated list.** Catalogues change weekly and formats disagree
  (`opus` vs `provider/model`); a stale dropdown silently withholds the model
  someone wants.
- **`model_used` is parsed from the run's stream and displayed** — verified against
  Claude Code, which reports `model = claude-opus-5-5` on its `system` event. Kept
  separate from the requested model, because `--fallback-model` exists and "asked
  for opus, ran on sonnet" is the interesting fact.
- On live lanes the UI reports the model rather than offering an inert control.

**Test:**
1. Add an Antigravity CLI agent, run it via the runner, and see its answer in the session.
2. Same for OpenCode, with `-m provider/model`.
3. Set a model on a spawn-enabled agent; the timeline shows which model the run
   actually used.
4. Set a nonsense model; the run fails **visibly**, with the provider's own error.
5. A live-session agent shows no model control, and reports the model its own
   config chose.
6. Two agents in one session on different models both work.

## M17 — First run: from an invite link to your own agent in the room

> Every session needs a second person, so every use of Fabrikka sends an invite.
> That's the growth loop, and today it leaks at the step that matters. The invitee
> lands in a session that only says what it's called, joins a conversation already
> under way, and has to find out on their own that the **Agents** panel in Setup is
> where their agent comes in. The moment worth telling someone about is watching
> *your own* agent work beside someone else's, and right now nothing leads the
> invitee there.

The goal is to get from opening an invite link to the invitee's own agent showing
up in the timeline in as few steps as possible, and to make that arrival
something the rest of the room sees.

- **The invite page says who and what.** The preview shows who sent the invite
  and who is already in the session: humans and agents, by display name. The link
  already lets its holder join, and joining shows them all of this, so the preview
  reveals nothing new. An invalid, expired or revoked invite still shows nothing
  at all. Message content, outputs and context are never shown before joining.
- **Joining leads into "Bring your agent".** After signup, or after *Join session*
  for an existing account, the invitee lands on the session with a step open:
  - The agent's name is pre-filled as `<provider-short>-<display name>`, for
    example `claude-alice`. If that name is taken, a number is appended.
  - The provider defaults to Claude Code. One click creates the session agent
    through the same path M11 opened to members, so there is no new permission
    and no new API.
  - The setup block for the recommended lane shows next to a copy button: Lane A's
    one-liner for a Claude Code or Codex agent, and the endpoint and header for
    anything else. The other lanes stay one click away.
- **The step waits for the agent and says so.** It shows *Waiting for
  claude-alice to connect…* and flips to *claude-alice is here* on the first
  authenticated connection, from any lane. This screen is where the invitee
  succeeds or gives up, so it never just goes quiet.
- **Skipping is allowed.** *Not now* closes the step. It stays reachable from
  Setup, and the choice is remembered per session.
- **Arrivals are marked in the timeline.** When a human redeems an invite, and
  when a session agent connects **for the first time ever**, every member sees a
  durable marker: *alice joined*, and *claude-alice joined: Alice's Claude Code*.
  - The server writes the marker. The agent is never asked to introduce itself,
    for three reasons. Fabrikka does not drive the agent. A forced greeting costs
    the user a model turn they didn't ask for. And a Lane A client takes no turn
    until its user prompts it.
  - A marker is written once per participant, never on reconnect.
  - Like activity, markers are **display data**. They are never delivered to an
    agent, never a mention, and never counted against the turn budget. An agent
    that wants to know who is present calls `list_participants`.
- **The operator can see whether the loop works.** `admin funnel` prints
  aggregate counts from this instance's own tables:
  - invites created, redeemed, and redeemed by a new account;
  - redeemers who connected an agent within 7 days;
  - redeemers who later created a session or sent an invite of their own.

  These are counts only, never per-user rows, and nothing leaves the instance.
  There is no telemetry.

Out of scope: a share-anywhere link (an invite is a single-use bearer
credential, so it stays one), email nudges (ADR 0007), and anything visible
outside the instance. Outward attribution and shareable recaps change the
privacy model and get their own ADR.

**Test:**
1. As fede, create an invite and open it in a private window. The page names fede
   as the sender and lists the session's participants, but no messages.
2. Revoke a second invite and open it: the page shows only *This invite can't be
   used*, with no names.
3. Redeem the first invite as a new account, alice. She lands in the session with
   *Bring your agent* open, the name `claude-alice` filled in, and Claude Code
   selected.
4. Fede, in his own window, sees *alice joined* in the timeline without reloading.
5. Alice clicks create, copies the one-liner and runs it in a real Claude Code.
   Her step flips to *claude-alice is here*. Fede sees *claude-alice joined:
   Alice's Claude Code*.
6. Restart alice's Claude Code. No second marker appears.
7. Mention `@claude-fede`. The run's context contains no join markers, and the
   turn budget is unchanged by them.
8. Invite bob, who already has `claude-bob` in another session and picks *Not
   now*. The step closes, stays closed after a reload, and *Agents* in Setup
   still offers it.
9. Create the name collision on purpose: a member named alice whose
   `claude-alice` already exists gets `claude-alice-2`.
10. `pnpm admin funnel` shows invites created 2, redeemed 2, new accounts 1,
    connected an agent 1. No email addresses or names are printed.

## M18–M27 — The stories

> **Added 2026-10-03.** Ten milestones, each finished by a **user story**. The story
> is the acceptance test, run end to end with real accounts. Where a story needs
> a capability that isn't built yet, the capability is the milestone and the story
> is its gate. The twelve stories, and which milestone completes each one:
>
> | # | Story | Completed at |
> | --- | --- | --- |
> | S1 | Team debugging: GitHub, Sentry/Grafana/Rollbar, a PR, a ticket moved, Confluence checked | M18 |
> | S2 | A team, and a session every teammate can view | M22 |
> | S3 | A team, and a session just for yourself | M21 |
> | S4 | A private session, then add a teammate | M21 |
> | S5 | A Confluence page, two repos, a PDF, tickets created in an epic | M20 |
> | S6 | The 2 a.m. incident, picked up by another time zone from the record | M24 |
> | S7 | The async handoff: my agent finishes overnight and hands the work to Alice | M24 |
> | S8 | Shaping a pitch before anyone builds | M25 |
> | S9 | A student group writes a paper; the advisor comments without editing | M23 |
> | S10 | Leaving the cloud: a six-month decision with its history intact | M27 |
> | S11 | Onboarding by doing, with a senior's agent lent read-only | M26 |
> | S12 | An agency and its client in one room, and no more | M23 |
>
> **What none of them needs:** dashboards, kanban, analytics, digests or "AI
> insights". A story that seems to need a new screen is probably the wrong story.

## M18 — Connections: connect a category, not a vendor

> M8 aggregates any MCP server, but connecting one means pasting a URL and a
> bearer token, and most vendors' MCP servers authenticate with **OAuth**. Nobody
> on a team will do the first, and the second is impossible today.

Connections are offered **by category**, and each one is the **vendor's own MCP
server** ([ADR 0024](decisions/0024-connections-are-categories-over-vendor-mcp-servers.md)).
Fabrikka writes no vendor adapters, and agents use the vendor's tools directly.

**First wave, in this order (2026-10-07): GitHub, Jira, Confluence, Grafana.**
Probed before any code (unauthenticated requests to each server and its OAuth
metadata):

| Vendor | Category | MCP server | Sign-in | Operator setup |
| --- | --- | --- | --- | --- |
| GitHub | Code host | `https://api.githubcopilot.com/mcp/` | OAuth via `github.com/login/oauth`: PKCE, **no dynamic registration** | **A GitHub OAuth App**, once per instance (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`). Without one, GitHub is absent. |
| Jira | Issue tracker | `https://mcp.atlassian.com/v1/mcp` | OAuth: PKCE, dynamic registration | none |
| Confluence | Docs | the same Atlassian server | the same: **one Atlassian connection serves both entries** | none |
| Grafana | Observability | `https://mcp.grafana.com/mcp` (Grafana Cloud) | OAuth 2.1: PKCE, dynamic registration; the stack is chosen with an `X-Grafana-URL` header | none |

**Prepared, not listed.** An entry written from a real probe, but kept out of
`registry.ts` until it has been connected for real:

| Vendor | Category | MCP server | Sign-in | Operator setup | Entry |
| --- | --- | --- | --- | --- | --- |
| Linear | Issue tracker | `https://mcp.linear.app/mcp` | OAuth: PKCE (S256), dynamic registration, scopes `read write` (probed 2026-10-10) | none | `catalogue/linear.ts`. Offered on an instance with `FABRIKKA_PREPARED_VENDORS=linear`, marked *Preview* (`docs/operations.md`). Listed once the owner connects it; presets come from that connection's tools. M20 runs with both Jira and Linear (owner, 2026-10-10). |

Later wave: GitLab, Linear, ClickUp, Sentry, Rollbar, Notion. Each is probed and
connected for real before it gets an entry. Self-hosted Grafana
(`grafana/mcp-grafana`, a service-account token) stays a **custom connection**.

- **Add a connection → a category → a vendor → Connect.** Each catalogue entry
  (`apps/server/src/connections/catalogue/<vendor>.ts`, plus one registry line)
  knows its endpoint, how it authenticates, and any field the person must fill
  in (Grafana's stack URL). You never paste a URL for a listed vendor.
- **OAuth per the MCP authorization spec:**
  - protected-resource discovery (RFC 9728) and authorization-server metadata
    (RFC 8414);
  - dynamic client registration (RFC 7591) where the vendor supports it, or the
    entry's pre-registered client otherwise;
  - PKCE (S256), and a single-use `state` bound to the person who started it;
  - the callback is on the instance's own origin
    (`/api/connections/oauth/callback`), so `localhost` works with no domain.
- **Tokens:**
  - access and refresh tokens are sealed under `FABRIKKA_ENCRYPTION_KEY`, per
    user, never returned (ADRs 0004, 0014);
  - an expired access token is refreshed before the upstream call;
  - a refresh that fails marks the connection *needs reconnecting*, never
    silently empty.
- **One connection, several entries.** Jira and Confluence are one Atlassian
  connection. Connecting either connects both, and they share one slug
  (`atlassian`), so grants are per Atlassian tool.
- **Grant presets per entry,** *Read* and *Read & write*, expand to the per-tool,
  default-deny grants M8 already enforces. An entry's tool lists come from
  listing that vendor's tools in a real connection. A tool an entry doesn't
  classify is in no preset.
- **Custom connection** stays: any streamable-HTTP MCP server, with a URL and
  token, as at M8.
- **Personal integrations stays tidy as the catalogue grows (2026-10-10):**
  - **Your connections** come first, as a compact list with each vendor's logo,
    its status, how many sessions use it, *Reconnect* and *Remove*.
  - **Add a connection** below it:
    - a **search** box matching name, category, description and the entry's
      keywords ("tickets" finds Jira, "atlassian" finds both);
    - **category chips** (*All*, then each category with its count);
    - a grid of vendor cards, **each with its logo**.
  - A search with no match offers a custom connection instead.
  - A logo is data in the vendor's own file: one SVG path and a brand colour,
    from [Simple Icons](https://simpleicons.org) (CC0), pinned to a version.
    No image files, no new dependency. A custom connection, or an entry without
    one, gets a monogram tile.
- **Credentials stay per user and sealed.** Every call still runs under the
  calling participant's own account.

**Test, per vendor as it lands** (clicks counted from *Personal integrations*):
1. **Add a connection →** category **→** vendor **→ Connect →** the vendor's
   consent screen **→ Allow**: back in Fabrikka, *connected as <account>*.
   Typing the vendor's name in the search box finds the same card; every card
   shows the vendor's logo.
   That's at most 5 clicks in Fabrikka (GitHub, Jira; Grafana adds its stack
   URL).
2. In a session, Setup shows it. **Read** preset → an agent lists issues /
   repos / dashboards through it. A write tool stays absent until **Read &
   write**.
3. A day later, or with the access token forcibly expired, the next call
   refreshes it with no click.
4. Revoke the app on the vendor's side: the connection shows *needs
   reconnecting*, and **Reconnect** is one click plus the vendor's consent.
5. Scripted, against a local fake OAuth+MCP server: discovery, dynamic
   registration and the pre-registered client both work; PKCE and `state` are
   enforced (a forged or reused `state` is refused); tokens are sealed and never
   returned; refresh works; a revoked refresh token gives *needs reconnecting*.

**Story test, S1 (first wave):** Fede connects GitHub, Jira, Confluence and
Grafana and adds `claude-fede`. The agent finds the failing endpoint on a
Grafana dashboard, finds the code in GitHub, opens a PR, links the Jira ticket
in it, and moves the ticket to its next status, asking Jira which transitions
exist rather than assuming one. Then it checks Confluence for docs that need
updating. The Linear run of the original S1 waits for the later wave.

## M19 — Session links: what this session is about, outside it

The session gets a small, **vendor-neutral** record of the outside things it
touches:

```
{ type: issue | pr | repo | page | dashboard | error, provider, url, title, status, status_at }
```

- Agents add links with a `link` tool, and humans add them in the right pane.
  Links are **append-first**, like context (ADR 0013).
- `status` is **as last reported**, with its time. Fabrikka never polls a vendor
  on its own; status refreshes when an agent or a person looks.
- A session can link **several repos**, and the session preamble lists them, so
  an agent starts knowing which code the session is about.
- A link is a pointer, never a copy: no ticket bodies or PR diffs are stored. The
  vendor is the source of truth.

**Test:** in S1's session, the right pane shows the ticket, the PR, the Confluence
page and the Sentry issue, each with its provider and status. The agent's ticket
move updates the ticket's status. Link two repos: a fresh run's preamble names
both.

## M20 — Agents read what you upload

M7 stores a PDF; an agent can't read it.

- Text is extracted **on the server** from uploaded PDFs, page by page, with size
  limits. `read_artifact` gains `start_page` / `max_pages`, mirroring
  `read_output`. The extractor is `pdf.js`, already in the web app, so the server
  is its second consumer.
- A scanned PDF with no text layer says so. It is never silently empty.
- The text is data, not instructions, like every other piece of content (security.md).

**Test — S5:** connect Confluence, Jira and GitHub. Link two repos, upload a PDF
spec, and ask an agent to review the Confluence page against the PDF and both
codebases. It creates several Jira tickets under one epic, and each appears in
the session's links. Then run it again with Linear, using a project in place of
the epic.

## M21 — Teams

> A team is a list of people who already trust each other, plus nothing else.
> Not billing, SSO or a permission matrix: those stay off the roadmap.

([ADR 0025](decisions/0025-teams-and-who-can-see-a-session.md))

- Create a team, and invite people to it with the same single-use links (M1). A
  team invite is a second way to get an account. There is still no open signup.
- Team roles: `owner | member`. Owners invite and remove; that is the difference.
- **Add from the roster**: a session owner adds a teammate directly, with no link,
  because the server already knows they're allowed to be added.
- A session belongs to a person, and **optionally** to a team. Sessions are still
  **private by default**: belonging to a team changes who can be added, not who
  can see.
- Leaving or being removed from a team removes **team-granted** access only.
  Membership granted by a direct invite stays.

**Test — S3 and S4:** Fede creates a team and invites Alice and Bob. He creates a
session for himself in the team: Alice and Bob can't see it, and get a 404 on its
URL. He adds Alice from the roster: she's in, with no link. Remove Alice from the
team: she's out of that session, since her access came from the team.

## M22 — Who can see a session: team-visible, and guests

([ADR 0025](decisions/0025-teams-and-who-can-see-a-session.md), plus a new threat
section in `docs/security.md`)

- A session's visibility is `private` (default) or **`team`**. A team-visible
  session is visible to every member of its team as a **viewer**.
- **Viewers read.** They see the timeline, outputs, context and links. They
  can't post, can't mention, can't trigger an agent and don't see Setup. Joining
  as a participant still takes an owner's say-so.
- **Guests**: an owner can invite someone **outside** the team as a viewer of one
  session, for a client or an advisor. A guest sees one session and nothing else
  about the team.
- The word is **"team-visible", never "public"**. "Public" means outside the
  instance (ADR 0022), and confusing the two would be a security bug.
- A team-visible session is still a 404 for anyone outside the team.
- An agent's activity follows its owner's `activity_visible`. Viewers see no more
  than members do.

**Test — S2:** Fede creates a team-visible session. Every teammate sees it in
their list and can read along live; none of them can post or mention. Carol,
outside the team, gets a 404. Fede invites a guest viewer: she sees that one
session and nothing else of the team.

## M23 — Comments on outputs

> Review is a conversation *about a passage*, not about the document. The
> timeline is the wrong place for "this paragraph contradicts section 2".

- Comments **anchor to a passage** of an output, by quoted text like anchored
  edits (ADR 0019). A comment whose passage has been rewritten is marked
  *outdated*, never silently moved.
- **Guests and viewers can comment**; only participants edit. "Comment, don't
  edit" is the most common thing a reviewer wants.
- Agents read comments (`list_comments`) and can resolve them by editing, with
  the edit linked to the comment. Comments are data, not instructions, and a
  comment never triggers an agent.
- Threads resolve; resolved threads collapse, they don't disappear.

**Test — S9:** four students write a LaTeX paper (M13), each with their own
agent. Their advisor is a guest. She comments on two passages; an agent fixes one
and resolves it; the other gets marked outdated when a student rewrites the
paragraph. The changes log says who wrote what.

**Test — S12:** an agency opens one session per client. The client is a guest on
the client session: they see the proposal, the decisions and the agents drafting,
and comment on the proposal. The agency's internal session doesn't exist as far
as the client can tell (404).

## M24 — Since you were away

> Most of the work in a session happens while someone is asleep. The record
> exists; the problem is finding where you left off.

- **Catch-up on return**: opening a session after an absence shows what changed
  since you last looked. That means new decisions, answered and new open
  questions, outputs edited (and by whom), links whose status moved. It is built
  from the record, not generated: Fabrikka has no built-in model.
- **Waiting for you**: one list, across your sessions, of mentions of you and of
  open questions addressed to you. It is the only cross-session view, and it
  holds nothing a session doesn't.
- **Handoffs**: an agent finishing work can mention a human. That mention waits
  in their list like any other. No new mechanism: an agent mentioning a human
  wakes no one and costs no turn budget.
- Email stays optional (ADR 0007). With a notifier configured, *Waiting for you*
  can be mailed. Without one, it's a page.

**Test — S6:** Fede opens "Checkout 500s" at 2 a.m., connects Sentry and Grafana,
and his agent records what it found as facts and decisions. Alice opens it eight
hours later: the catch-up shows the decisions and the one open question, and she
continues without reading the timeline.

**Test — S7:** Fede writes "@claude-fede finish the migration, then hand it to
@alice" and logs off. The run finishes, opens the PR, records the question it
couldn't answer, and mentions Alice. Her *Waiting for you* has it in the morning.

## M25 — Session templates

> **UI parked, 2026-10-04.** For now a session has no type: the new-session form
> asks only for a title, and *Save as template* and the suggested connections
> are hidden. Templates come back later, when a team or a person defines session
> types of their own. The server, the API and the m25 check stay as built, so
> bringing them back is a UI change.

- A **template** is a session's structure without its content: the objective,
  constraints, starter open questions, starter outputs (a pitch with empty
  sections, an incident report's headings), and recommended connection
  categories. Setup notes for agents go in a starter output, where agents can
  read them.
- **Save as template** from any session; **New session from template** fills the
  structure and nothing else. No messages, credentials or members are copied.
- Templates belong to a person or a team. Fabrikka ships a few: *Shaping*,
  *Incident*, *Onboarding*. They are plain data, one file each, editable, and not
  special. Adding one is a file and a registry line.

**Test — S8:** a product lead starts from *Shaping*: problem, appetite, solution,
rabbit holes, no-gos, and a pitch output. Agents add rabbit holes to the context
and draft the pitch; reviewers comment on it (M23). The team decides to bet on
it, or not, and records that decision in the session.

## M26 — Lend your agent, read-only

> The senior engineer's agent knows the codebase. The new hire should be able to
> ask it anything, and it should be able to change nothing.

**ADR before building**: this sits on the trust model (security.md) and ADR 0011.

- An agent's owner can **lend** it in one session with a **profile**:
  `read-only`, meaning trusted to be mentioned by session members but run with no
  write access.
- The profile is **enforced where the run starts**: the owner's runner passes the
  runtime's own read-only flags (Claude Code's plan mode or a restricted tool
  list, Codex's read-only sandbox). The runner already builds that command line
  (ADR 0011).
- **A live session can't be lent this way.** Fabrikka can't restrict tools in
  someone's open terminal, so a lent agent answers on the spawn path only. The UI
  says so, as steering does (ADR 0016).
- Lending is per session, revocable, and visible to everyone in the session.

**Test — S11:** a new hire is invited to a session made from *Onboarding*, with
three real tickets and a senior's agent lent read-only. They ask it about the
codebase all day; when they ask it to edit a file, the run is refused by its own
sandbox, and the session says so. On Friday their PR merges, and the session is
saved as the next hire's template.

## M27 — Export: the record is yours

> A decision you can't get out of the tool that holds it isn't yours.

- **Export a session** as Markdown plus a folder of files: objective, context
  with its history, decisions, links, outputs at their current version with
  their changes log, artifacts, and the timeline.
- **Context history** is recorded from M27 on: who added or removed each fact,
  decision, question and constraint, and when. Items from before then have no
  history, and the export says so rather than guessing.
- Also **JSON**, for anything that wants to read it programmatically.
- Owners export; it is a deliberate act, and the file says who exported it and
  when. Activity is excluded, as it is everywhere (ADR 0015).
- No proprietary format and no "import into Fabrikka" lock: the export reads
  fine in a text editor.

**Test — S10:** a CTO runs "Cloud exit" over weeks: infra repo linked, bills
uploaded and read (M20), one decision per managed service, a migration plan as a
live doc. Export it. The Markdown answers "why did we choose this" for every
decision, with who decided and when, and opens in any editor.

## M28–M30 — The home: a place to come back to

> **Added 2026-10-04.** Until now the home page has been a list of sessions. A team
> that lives in Fabrikka needs what a team chat tool gives it: one place where its
> ongoing conversations, its pieces of work and its people are a click away. These
> three milestones make the home feel like that, without making sessions into
> chat rooms or chat rooms into sessions.

## M28 — The home: a sidebar, and a team switcher

- **A sidebar that stays.** It's on the left of the home page *and* beside every
  open session, so moving between pieces of work never means going back to a
  list. It collapses on narrow screens.
- **A team switcher** at the top, like a chat tool's workspace switcher: one team
  at a time, remembered per browser. Personal sessions and direct chats (M29)
  show under every team, because they aren't any team's.
- **Sections:**
  - **Team sessions**: the team's 5 most recently active sessions you can open
    (as a member, or as a viewer of a team-visible one), plus **All team
    sessions**, a full list you can filter by title.
  - **Personal sessions**: sessions in no team, most recent first.
  - **Personal integrations**: your own connections, on a page of their own.
    You connect, see and remove them here, not inside a session; attaching one to
    a session stays in that session's Setup (M8).
- "Most recently active" means the latest message, or the session's creation if
  it has none. Fabrikka doesn't track who looked at what beyond your own read
  position (M24).
- **Starting a session happens where the sessions are.** A **+** beside *Team
  sessions* starts one in the current team, and a **+** beside *Personal sessions*
  starts one just for you. Either way you give a title (session types come later;
  see M25).
- **The home's main area**, with nothing open, shows *Waiting for you* (M24).
- Nothing here is a new permission. The sidebar shows exactly what the session
  list already showed, arranged by team.

**Test:**
1. Fede is on two teams. The switcher lists both. Choosing one shows its sessions
   in **Team sessions**, at most 5, newest activity first, and a reload remembers
   the choice.
2. Post a message in the 6th most recent team session: it moves into the top 5.
3. **All team sessions** lists every one; typing in the filter narrows it.
4. A personal session (no team) appears under **Personal sessions** whichever team
   is selected.
5. Open a session: the sidebar is still there, and clicking another session
   switches without going home.
6. **Personal integrations** lists Fede's connections. Connect one there, then
   open a session's Setup: it's offered to attach. Remove it on the page: it's
   gone from the list.
7. A team-visible session Fede can only view appears under Team sessions, marked
   as view-only.
8. At phone width the sidebar is a drawer, and nothing is clipped.

## M29 — Team chats and direct chats

> A chat is where a team talks; a session is where it works on one problem. They
> share an engine ([ADR 0026](decisions/0026-chats-are-a-light-kind-of-session.md)),
> so agents can be mentioned in a chat, and a conversation that turns into real
> work can become a session without being copied anywhere.

- **Team chats.** A team has chats, like a chat tool's channels: *#general* is
  created with the team, and any member can add more. **Every team member is a
  member of every team chat**, through the team (M21's `via_team_id`): joining
  the team brings you in, and leaving takes you out.
- **Direct chats.** A 1:1 chat with someone you share a team with. There is one
  per pair of people, and it belongs to no team, so it shows under every team.
  The sidebar lists your most recent ones.
- **A chat is a light session.** It has the timeline, mentions and agents, and no
  output pane. Its Setup shows only members and agents. Mentioning an agent in a
  chat follows the same delivery gate and trust tiers as anywhere else (security.md).
- **Turn a chat into a session.** When a thread becomes real work, a member starts
  a session from it, and the new session's opening context links back to the
  chat. Nothing is copied: the chat keeps its history.
- Unread markers come from M24's read positions: a chat with messages since your
  last visit shows as unread in the sidebar.

**Test:**
1. Create a team: it has *#general*, and every member sees it in **Team chats**.
2. Alice joins the team through an invite: *#general* is in her sidebar, and she
   can post there.
3. Fede creates *#incidents*. Alice sees it without being added.
4. Remove Alice from the team: she's out of both chats (404), and her old
   messages stay, attributed to her.
5. Fede opens a direct chat with Bob, a teammate. Bob sees it under every team
   he's on. Opening it again from either side reaches the same chat.
6. Fede can't open a direct chat with Carol, with whom he shares no team.
7. In *#general*, `@claude-fede what broke?` is delivered to Fede's agent when
   Fede writes it, and refused when Alice does (owner_only), exactly as in a
   session.
8. A chat shows no output pane, and its Setup has only members and agents.
9. Start a session from a chat: it opens with a link back to the chat, and the
   chat is unchanged.
10. Post in a chat while Alice is away: it shows unread in her sidebar until she
    opens it.

## M30 — Team integrations: credentials the whole team shares

> **Last of the three, by design.** Credentials have belonged to one person since
> ADR 0004, so that every call names the person behind it. Some connections are
> genuinely the team's: a shared Sentry org token, a team's CI account.
> [ADR 0028](decisions/0028-team-credentials-are-shared-marked-and-lose-to-your-own.md)
> admits those **as team credentials, marked as shared everywhere they appear**,
> superseding ADR 0004 for them specifically.

The ADR's answers:
- **Who adds one:** team owners only. Members see that it exists, never the secret.
- **Who uses one:** every current team member, and their agents, in the team's
  sessions. Never guests, never in a personal or another team's session.
- **Precedence:** your own credential for the same integration wins; the team's
  fills the gap.
- **Shown as shared:** in the tool description the agent reads, in the session's
  Setup (*team's · shared*), and on Team integrations.
- **Audit:** every call made with a team credential is recorded with the
  participant who made it, the tool, and the outcome. Never its arguments or
  results. Team owners see recent uses.

- **Team integrations** joins the sidebar: the team's shared connections, managed
  by team owners.
- Everything else about connections is unchanged: per-tool grants stay
  default-deny, and credentials are sealed and never returned (ADR 0014).

**Test.** An upstream fixture that reports the token it saw, so the routing is
proved rather than assumed. Fede owns team T; Alice is a member; Carol is a guest
in one of T's sessions, not on the team.

1. Fede, sidebar → **Team integrations**, fills in name, server and token →
   **Save**: **2 clicks**. The token is never returned by any API.
2. Alice opens Team integrations: she sees the connection and who added it, not
   the token, and has no form. Adding one as her is refused.
3. In a session of T: Fede opens **Setup**, the team's connection shows *team's ·
   shared* → **tools** → allows one: **3 clicks**. Before that grant, nobody's
   agent lists the tool. Adding a team credential grants nothing.
4. Alice's agent lists the tool; its description says it uses T's shared
   credential. Calling it reaches upstream with **the team's token**.
5. Alice attaches her own connection with the same name: the same call now
   reaches upstream with **her** token, and the description says *your own*.
   Detaching it falls back to the team's.
6. Carol's agent, in the same session, has no such tool, and calling it by name is
   refused.
7. The same team connection is absent in Fede's personal session and in another
   team's session.
8. Fede removes Alice from T: her agent loses the tool on its next listing, and a
   call is refused.
9. Team integrations shows Fede the recent uses: Alice's agent, the tool, ok. Alice
   no longer sees the page at all; while a member, she saw no uses.
10. Fede removes the team connection: it's gone from every session of T at once.

## M31 — The local host: your agents, in folders you choose, safely

> Adding your agent to a session means pasting a setup block, with a token, into a
> terminal, once per session and per agent, and the runner dies with the terminal.
> That fails the five-click rule outright (CLAUDE.md). And Claude Code runs with
> no sandbox at all.

A small app on your computer, paired with your account once, that runs your
agents in **folders you grant on the machine**, each with a policy the agent tool
itself enforces
([ADR 0027](decisions/0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md)).

- **Pair once.** The host shows a code; **Connect** opens `/pair`, you confirm, and
  it holds a device token, revocable on the web under *Your devices*. No token is
  ever pasted.
- **Grant folders in the host, never on the web.** Each grant has a label you pick
  and a policy: *Read only*, *Edit in folder* (the default) or *Full*. Home
  directories and filesystem roots are refused. The server sees the label, never
  the path.
- **Add my agent** in a session's Setup lists your devices and their grants. Pick
  one and the agent is bound to it. The provider is detected from what's installed
  on that machine, and the agent's name defaults to `claude-<you>`.
- **A mention becomes a run request** (session, agent, grant id, message), never a
  command or a path. The host builds the command from fixed templates and the
  grant's local policy, with a per-run token.
- **See and stop:** a tray icon while running, a local log of every run, and
  **Stop all**. The session kill switch still works from the web.
- The CLI runner stays, gains the same three policies as flags, and also
  defaults to *Edit in folder*.

> **Verified for Claude Code** (ADR 0027, `scripts/spikes/m31-policies.mjs`): exact
> tool lists, strict MCP config, refusals outside the folder including through
> symlinks, no hang in headless runs, the session tools still work. **Codex isn't
> verified yet**: its CLI isn't installed here. Until it is, Codex agents can't be
> bound to a host folder rather than running unsandboxed.

**Test:**
1. Install and start the host. **Connect** (1 click), confirm the code in the
   browser (1 click). *Your devices* on the web lists the machine. Pairing: **2
   clicks, once.**
2. In the host, grant `~/code/demo` as *Edit in folder*. Try to grant `~`: refused.
3. In a session: **Setup → Add my agent → demo → Add**. That's **4 clicks** (counting
   opening Setup), with nothing copied. The agent shows as connected through the
   host.
4. Mention it to fix a typo in a file in `demo`: the run edits the file, posts its
   answer, and the host's log shows the session, folder and policy.
5. Ask it to run `ls ~` or fetch a URL: refused by the tool's restricted mode, and
   the session says so. Ask it to read `../outside.txt`, a sibling of `demo`:
   refused.
6. Re-grant `demo` as *Read only* in the host and ask for an edit: refused. The web
   never offered a way to change the policy.
7. Send a run request naming a grant the host doesn't have (from a test script):
   refused and reported. The host never runs a command the server composed.
8. **Stop all** in the host during a run: it ends, and the session shows the run
   stopped.
9. Revoke the device on the web: the host disconnects, and the agent shows offline
   in its session.
10. A teammate's mention of your `owner_only` agent is refused before it ever
    reaches the host, as today.

## M32 — The core as a library: extensions, email, and password reset by email

> A hosted instance needs a way for a stranger to start, and a way back in for
> someone who forgot a password and can't run the CLI. A deployment adds its
> sign-up and other routes without forking, using the core as a library
> ([ADR 0029](decisions/0029-the-core-is-a-library-a-deployment-extends-it.md)).
> This milestone is the core's half: the library, the kit and email.

- **`createApp(options)`.** The server module becomes a function that builds the
  app unstarted. The core's own entry point is `createApp().start()`: running the
  core alone is unchanged, and every existing acceptance check passes untouched.
- **Extensions and the kit.** `options.extensions` mount their routes before the
  web app's catch-all and receive the kit. The kit's functions are documented in
  `docs/protocol.md`:
  - **Accounts:** `createAccountWithOwnTeam` (the only way the kit creates an
    account: a new user and a new team they own, in one transaction), `signIn`,
    `findUserByEmail`.
  - **Email:** `sendEmail`.
  - **Rate limiting:** `rateLimit`, `clientIp`.
  - **Other:** `requireUser`, `publicUrl`, the database handle.
  - **Advertising:** `advertise({ signupUrl })`, which makes the login page offer
    *Create an account*.
- **Email transport.** `FABRIKKA_MAIL`: `none` (the default), `log`, or
  `file:<dir>`. A provider transport comes later (M45, SMTP).
- **Password reset by email**, for self-hosters too, offered only when a
  transport is configured:
  - **The link:** single-use, hashed at rest, valid for one hour.
  - **Using it** logs the account out everywhere.
  - **The request** answers the same whether or not the email has an account, and
    is rate-limited per email and per IP.
- **`GET /api/auth/options`** tells the login page what to offer: password reset,
  and a sign-up page if an extension advertised one.

**Test.** Clicks are counted from the login page.
1. With no `FABRIKKA_MAIL`: the login page offers no *Forgot password?* and no
   *Create an account*. Asking for a reset is refused. `pnpm admin
   reset-password` still works.
2. With `FABRIKKA_MAIL=file:<dir>`: *Forgot password?* → enter the email →
   **Send** → open the link from the email → new password → **Save**: **4
   clicks**. The old password stops working, and every other login of that
   account is signed out.
3. The same link a second time is refused. A link older than an hour is refused.
4. An email with no account gets the same answer and no message is sent. After
   five requests for one address within fifteen minutes, further requests are
   refused for a while.
5. A test deployment (`createApp` plus a fixture extension, on another port):
   - its route answers, and the login page offers *Create an account*;
   - `createAccountWithOwnTeam` makes a user who owns one new team with only
     themselves in it, and who sees no other team and no session;
   - an invite from someone else still brings them into that person's team.
6. The core's own server, started as before, offers none of the fixture's routes.

## M33 — Install the client with one line, from your own instance

> The local client can't be installed today: it isn't on npm, and building it
> means cloning the monorepo. [ADR 0030](decisions/0030-every-instance-serves-its-own-client-installer.md):
> every instance serves its own client and installer, so connecting a computer is
> one pasted command and one click, and the client always matches its server.

- **One file.** The bridge bundles `ws` too, so `dist/cli.js` runs with nothing
  installed beside it. It needs Node 22 or newer. The build stamps a version
  into it (`fabrikka --version`) and writes the same version to
  `dist/version.json`.
- **Three public routes:**
  - **`GET /install.sh`:** the installer, with this instance's `PUBLIC_URL`
    written in.
  - **`GET /downloads/manifest.json`:** `{ version, file, url, sha256, size,
    node }`.
  - **`GET /downloads/fabrikka.mjs`:** the client file.

  All three answer 404 when the instance has no client build.
- **The installer** (POSIX `sh`, wrapped in a function called on its last line):
  - **Refuses** plain `http://` except for localhost.
  - **Checks for Node 22+**, and stops with directions if it's missing.
  - **Downloads** the manifest and the file, and refuses the file unless its
    SHA-256 matches.
  - **Installs** to `~/.local/share/fabrikka/` plus a `fabrikka` launcher in
    `~/.local/bin`, without `sudo`.
  - **Adds** one marked line to `~/.zshrc` or `~/.bashrc` if `~/.local/bin`
    isn't on the PATH (`--no-modify-path` skips it).
  - **Reports** whether `claude` and `codex` are installed, and installs neither
    (ADR 0002).
  - **Ends by running** `fabrikka host --server <instance>` (`--no-connect`
    skips it).
- **`fabrikka update`** fetches the paired server's manifest, verifies the
  checksum and replaces the installed file. It refuses to overwrite a copy it
  didn't install.
- **"Update available":** the server tells the host its client version when the
  host connects. An out-of-date host says so in its terminal and on its local
  page. Nothing updates itself.
- **Your devices** shows the install command for this instance, with **Copy**.
- **`BRIDGE_COMMAND` now defaults to `fabrikka`**, the installed client, instead
  of the unpublished `npx -y @fabrikka/bridge`.

**Test.**
1. Copy the bundle alone into an empty folder: `node cli.js --version` and
   `--help` work, with no `node_modules` anywhere.
2. With `HOME` pointed at an empty scratch folder:
   - *Your devices* → **Copy** the command → paste it into a terminal: **1 click
     and one paste**.
   - The browser opens the pairing page. **Connect this computer**: **1 more
     click**.
   - The host runs from `~/.local/bin/fabrikka` and lists this instance on its
     local page.
3. The launcher, the file and the one PATH line are where they should be.
   Running the installer again doesn't add a second PATH line.
4. A manifest whose checksum doesn't match the file is refused, and nothing is
   installed.
5. `http://` from a non-local address is refused. Without Node 22+, the installer
   stops with directions and installs nothing.
6. Rebuild the client and restart the server: the connected host reports
   "update available". `fabrikka update` installs the new file. `fabrikka
   --version` matches the manifest, and the notice is gone.
7. The installer never runs `sudo`, and never installs Node, Claude Code or
   Codex.

## M34 — The desktop app runs your agents

> M9's app is a thin shell; your agents still need a terminal. [ADR 0031](decisions/0031-the-desktop-app-runs-the-local-host.md):
> the app runs the local host itself, with its own bundled Node, a tray, and a
> Folders window that reaches the host with no network port. Unsigned until
> launch; the instance's installer can put it in place.

- **Host, `--control stdio`:** no HTTP page, no listening port. JSON lines on
  stdin and stdout: requests `{ id, op, … }` → replies `{ id, ok, … }`, plus the
  pushed event `{ event: 'pair', url, code }`. Every log line goes to stderr, so
  stdout carries only the protocol. The operations are the local page's: `state`,
  `grant`, `policy`, `remove`, `stop`.
- **One host per machine:** a lock file in `~/.fabrikka`. A second host, from
  the app or a terminal, refuses to start and says which process holds it.
- **The app:**
  - bundles an official Node build (pinned version, checksum-verified when
    fetched) as a Tauri sidecar, and `fabrikka.mjs` as a resource;
  - starts the host for the saved server, restarts it if it dies, and stops it
    on quit;
  - is a single instance: opening it again focuses the running one.
- **Tray:** status (connected, running), plus **Open Fabrikka**, **Folders…**,
  **Stop all runs**, **Start at login** and **Quit**.
- **Folders window** (bundled, local): the grants with their policy, and **Add
  folder**. Rust opens the native picker; no page ever supplies a path.
- **Pairing:** the host's `pair` event opens the pairing page in the main
  window, where you're signed in.
- **Capabilities:**
  - the host commands are allowed only to the local `folders` window;
  - no capability names a remote URL;
  - the main window, which shows the remote instance, can call no host
    command.
- **Installer, `--app`** (macOS on Apple Silicon):
  - downloads `Fabrikka-macos-arm64.zip` and its `.sha256` from the instance,
    and refuses a mismatch;
  - unpacks into `~/Applications` with `ditto`;
  - writes the instance's address into the app's settings, and opens it;
  - needs no Node and touches no PATH.

  The instance serves the zip when one has been built (`pnpm --filter
  @fabrikka/desktop package`).
- **Start at login** is on by default, chosen on the first-run page, and
  toggled in the tray.

**Test.**
1. `curl -fsSL <instance>/install.sh | bash -s -- --app`: the app is in
   `~/Applications`, opens without a Gatekeeper prompt, and goes straight to
   sign-in for that instance.
2. Sign in. The pairing page opens in the app: **Connect this computer**, **1
   click**. The tray shows "connected".
3. Tray → **Folders…** → **Add folder** → pick a folder → **Choose**: **3
   clicks**. Then **Setup → Add my agent → Add** in a session (3 clicks), and a
   mention gets its answer from that folder.
4. No process from the app listens on a TCP port for the host's control
   (`lsof`). The terminal host started meanwhile refuses: the lock is held.
5. **Quit** stops the host and its runs. Reopening starts it again, already
   paired. With **Start at login** on, it's registered as a login item.
6. Scripted: every stdout line of a `--control stdio` host is JSON, and its
   operations work, including the refusals (home folder, a missing path). The
   capability files give host commands to the `folders` window only, and name
   no remote URL. The app bundle's `fabrikka.mjs` is byte-identical to the one
   the instance serves. `--app` refuses a mismatched checksum and installs
   nothing.

## M35 — Codex on the local host

> Until now **Add my agent** offered Claude Code only: Codex's folder policies
> weren't verified. [ADR 0032](decisions/0032-codex-on-the-host-confines-writes-not-reads.md) records what verifying them found. Codex
> confines writes, network and its other tools, but **not reads**, and the
> picker says so.

- **Codex policies** (the runner and the host alike):
  - *Read only:* `-s read-only`.
  - *Edit in folder:* `-s workspace-write`, network off.
  - *Full:* `--approve-for-me`, as today.
  - **All three:** `approval_policy="never"`, web search off, and Fabrikka's
    MCP server pre-approved (`default_tools_approval_mode="approve"`).
  - ***Read only* and *Edit in folder* also:** a per-run isolated `CODEX_HOME`
    (only `auth.json`, linked; deleted afterwards), so none of the user's MCP
    servers, plugins or hooks load. Codex's computer-use, browser, app and
    plugin features are switched off.
- **The host accepts Codex** (`HOST_PROVIDERS` gains `codex`). A Codex agent is
  named `codex-<you>`.
- **The picker:** when a computer has both tools, *Run in which folder?* also
  asks **Claude Code / Codex**. Choosing Codex shows the read caveat, and adding
  it takes a confirming tick.
- **The Folders window and the host's page** carry the same caveat next to the
  policies.

**Test.**
1. In a session: **Setup → Add my agent →** a folder **→ Codex →** tick the
   caveat **→ Add**: **5 clicks**, counted from the session. The agent is
   `codex-<you>`, shown "on <computer> · <folder>".
2. Mention it in an *Edit in folder* folder asking to fix a typo: the file is
   fixed and the answer is posted.
3. In a *Read only* folder: the same request changes nothing, and the answer
   still arrives.
4. Scripted, with `FABRIKKA_TEST_SPAWN=1` (real Codex runs), through the host
   exactly as it runs Codex:
   - an *Edit* run can't write outside its folder or reach the network;
   - none of the user's own MCP servers is available;
   - *Read only* writes nothing, even inside the folder.
5. Scripted, always: each policy's Codex arguments, the isolated home (only
   `auth.json`), the server accepting a Codex binding, and the caveat present in
   the picker and the Folders window.

## M36 — A selector worthy of the app, and a resizable sidebar

> Native `<select>` menus render as the operating system's own pop-up buttons:
> grey, dated, and inside the desktop app (WKWebView on macOS) they look like a
> different program. This is an application people should enjoy opening.

- **One selector component** for the web app (`components/Select.tsx`):
  - **Looks:** a button in the app's palette showing the current choice, and a
    popover list. Options can carry a short description, and the team switcher
    shows each team's initial, the way a chat app's workspace menu does.
  - **Keyboard:** ↑ ↓ Home End to move, Enter or Space to choose, Escape to
    close, and typing jumps to an option.
  - **Behaviour:** closes on an outside click. It opens upward when there's no
    room below.
  - **Accessible:** the listbox pattern (`aria-haspopup`, `aria-expanded`,
    `role="listbox"`/`option`, `aria-activedescendant`).
  - It **replaces every native select** in the web app: the team switcher, a
    session's team, the agent tool and the link type.
- **Folder policies become a segmented control** (*Edit in folder · Read only
  · Full*) in the desktop app's Folders window and on the terminal host's page.
  All three choices stay visible, which suits a security setting better than a
  hidden menu. *Full* keeps its warning.
- **The sidebar is resizable**, like Slack's:
  - drag its right edge between 200 and 420px;
  - double-click the edge to restore 248px;
  - the width is remembered per browser (`localStorage`, a convenience only);
  - the edge is focusable, and ← → resize it by 16px
    (`role="separator"`, with its current, minimum and maximum values);
  - narrow screens keep the drawer and have no handle.

**Test.**
1. Every menu that was a native select now opens the app's own list, in the
   light and dark palettes, in the browser and in the desktop app.
2. Keyboard only: Tab to the team switcher, ↓ to open, ↓ ↓ Enter to switch
   team, and Escape closes without choosing. A screen reader announces it as a
   listbox with the selected option.
3. Drag the sidebar edge to about 360px; reload, and it's still 360px.
   Double-click the edge: back to 248px. It can't go below 200 or above 420.
4. Folders window: a folder's policy changes with one click on the segment.
   Choosing *Full* shows its warning.
5. Under 900px wide, the sidebar is the drawer as before, with no handle.

## M37 — The computer decides which agent tools it offers

> "Add my agent" asked *Which agent?* with two radio buttons, and each
> computer's tools were whatever happened to be on its PATH. Fabrikka will
> support 8, maybe 10 agent tools. Which ones a computer offers is that
> computer's call, made where its folders are granted.

- **One registry of agent tools**, in `@fabrikka/types` (`AGENT_TOOLS`), shared
  by the web app, the server and the host. Each entry holds:
  - `id`, `name`, and the `command` the host looks for;
  - an optional `caveat` the picker must show, with a confirming tick (Codex's
    read caveat, ADR 0032).

  Adding a tool the host can run is one entry here plus its policy flags in the
  runner. Nothing in the picker or the server changes.
- **Agent tools on this computer**, a section of the desktop app's Folders
  window and of the terminal host's page:
  - every registry tool is listed, marked installed or not;
  - each has a switch to offer it (on by default when installed);
  - the choice is kept in the host's own config (`~/.fabrikka/host.json`,
    `tools`), never on the server.
- **What the server sees:** a grant's `providers` is now the tools that are
  installed *and* switched on. Switching a tool off stops its agents on this
  computer, and they show as not running.
- **The picker:** *Which agent?* is the app's selector, listing the tools that
  computer offers by name. It's shown only when there's more than one. The
  chosen tool's caveat, if it has one, needs the tick before **Add**.

**Test.**
1. Folders window → **Agent tools**: Claude Code and Codex, both installed
   and on. Switch Codex off: within seconds the picker in a session offers
   Claude Code only, and asks no *Which agent?*.
2. Switch Codex back on: *Which agent?* returns as a selector. Choosing Codex
   shows its caveat, and Add waits for the tick.
3. A Codex agent already bound to that computer stops (not running) while
   Codex is off, and runs again when it's switched back on.
4. A tool in the registry that isn't installed shows as *Not installed*, and
   its switch can't be turned on.
5. Scripted: the registry is the only list of tools (no other hard-coded
   copy in the server, the picker or the host); `tool` over stdio switches a
   tool and changes the reported providers; turning on a tool that isn't
   installed is refused.

## M39 — One image, one compose file: host it yourself

> Self-hosting is the promise (PRINCIPLES.md, *Their tools, in their place*), and
> today it means a checkout, pnpm, a hand-made `.env`, a migration command and the
> admin CLI. Part of the road to MVP (`docs/mvp.md`, Phase 3). Built in parallel
> with the feature milestones, by the owner's decision (`CLAUDE.md`).

- **One container image** (`docker/Dockerfile`):
  - The server, the built web app, and the built local client, so the
    instance's own `/install.sh` works.
  - It runs as an unprivileged user and stores everything it keeps in **`/data`**
    (uploads, and a generated encryption key).
- **Migrations run when the server starts,** on every path: the image, `pnpm dev`
  and a deployment built on `createApp`. They're idempotent, and nobody runs
  them by hand any more.
- **`docker/selfhost/`, for any server with Docker:**
  - `compose.yaml`: the server, Postgres 17 and Caddy, which gets and renews a
    certificate for `FABRIKKA_DOMAIN`. Postgres isn't published outside the
    compose network.
  - `init.sh`: writes `.env` with every secret generated (the database
    password, `FABRIKKA_ENCRYPTION_KEY`) and asks for one thing, the domain.
    Nothing to invent.
  - Upgrading is `docker compose pull && docker compose up -d`. Backups: a
    `pg_dump` and the `/data` volume, documented in operations.md.
- **No encryption key configured?** The image generates one into `/data` on
  first start and reuses it, instead of refusing every credentialed
  integration.
- **The first owner is created in the browser** (ADR 0035): `/setup`, with a
  setup code from `FABRIKKA_SETUP_CODE` or the server log.
- **Not in M39:**
  - **S3-compatible storage for uploads.** Both one-click targets (M40) have
    disks; it comes when a target doesn't.
  - **The TeX engine,** about 360 MB. It stays optional, as in operations.md.
  - **The macOS app zip.** It's built on a Mac, and an instance without it
    simply doesn't offer `--app`.

**Test** (a fresh Linux server with Docker, and a domain pointed at it):
1. `git clone`, `./docker/selfhost/init.sh` (type the domain),
   `docker compose up -d`. That's the one-time setup, in a terminal on the
   operator's own server.
2. Open `https://<domain>`. It lands on **Set up Fabrikka**. The setup code is
   in `docker compose logs server`. Enter it with an email and password →
   **Create owner** (click 1). You're signed in.
3. **New room** (click 2) → a session opens. Invite someone, upload a file.
4. `docker compose down && docker compose up -d`: the room, the file and the
   sign-in survive. `/setup` is gone (404).
5. `curl -fsSL https://<domain>/install.sh | sh` installs the client from this
   instance.

## M40 — Deploy in one click

> M39 made self-hosting a terminal and three commands. Most people who'd run
> their own Fabrikka have a cloud account, not a server. Part of the road to
> MVP (`docs/mvp.md`, Phase 3), built in parallel with the feature milestones.

- **Render first: `render.yaml` at the repository root**, a Blueprint:
  - a web service built from `docker/Dockerfile`, with a **1 GB disk at
    `/data`** (uploads and the generated encryption key) and `/health` as its
    health check;
  - **managed Postgres 17**, reachable only from inside Render
    (`ipAllowList: []`), wired to `DATABASE_URL`;
  - **`FABRIKKA_SETUP_CODE` generated by Render**, so the setup code is in the
    service's *Environment* tab, not only in its log;
  - nothing to fill in. Render tells the service its own address
    (`RENDER_EXTERNAL_URL`), and the image uses it when `PUBLIC_URL` isn't set.
    It's the same for Railway (`RAILWAY_PUBLIC_DOMAIN`).
- **Disks are mounted as root** on these platforms. The image starts as root
  only to give `/data` to its unprivileged user, then runs as that user.
- **What it costs, said up front** in the docs: a disk needs a paid instance on
  Render (*Starter*), plus the database's plan. Render's free tier can't keep a
  disk.
- **The button.** "Deploy to Render" links to the Blueprint. The same Blueprint
  can be created from Render's dashboard (New → Blueprint → the repository), a
  fork included.
- **Railway second:** a template made in Railway's dashboard from the same
  image, with Postgres and a volume at `/data`, documented step by step. It's
  added once Render passes.

**Test** (a Render account, signed in; clicks counted from there):
1. New → Blueprint → the repository → **Apply** (one-time connection to GitHub,
   then 1 click). Wait for the deploy.
2. Open the service's URL. It lands on **Set up Fabrikka**. The code is in
   *Environment* (`FABRIKKA_SETUP_CODE`). **Create owner** (click 2).
3. **New room** (click 3). Upload a file. In Render, **Manual Deploy → Restart**
   the service: the room and the file are still there.
4. `PUBLIC_URL` was never typed: the invite links and `/install.sh` name the
   service's own `onrender.com` address.

## M42 — Needs you: know when a room wants you, wherever you are

> You work in three rooms at once: your own, one with some colleagues, one with
> others. An agent hands you work in one you aren't looking at, and today it
> waits until you happen to look. [ADR 0037](decisions/0037-needs-you-is-derived-and-reaches-you-where-you-are.md):
> "needs you" is derived from the record, shown as a number, pushed live, and
> becomes a system notification when you aren't in that room.

- **What needs you,** since your read position in a room:
  - a message mentioning you, from a person or an agent (a handoff is one);
  - in a direct chat, any message from the other person;
  - an agent you own finished, failed or was stopped there;
  - the room paused on its turn budget, for whoever can resume it.
- **Two levels in the sidebar:** unread is **bold** (M29, unchanged); needs you
  is bold **and a number** in the attention colour.
- **Per room:** *Everything* / *What needs me* (default) / *Nothing* (muted),
  from the room's header. Direct chats default to *Everything*. A muted room is
  never bold or numbered, and mentions still reach *Waiting for you*.
- **Live:** `/api/me/stream`, one WebSocket per person, carries count changes
  and a `notify` event per new item. The sidebar, the team switcher and the tab
  title follow it instead of waiting for focus.
- **Where it shows:**
  - the sidebar, with the number;
  - a dot on another team in the team switcher;
  - the tab title `(3) Fabrikka`, plus a dot on the tab icon;
  - browser notifications, once turned on (a banner, then the browser's
    *Allow*);
  - in the desktop app: the system notification, a dock badge and a tray dot,
    through `set_attention` and `notify` (ADR 0037's limits).
- **No notification for the room in front of you,** and none for your own
  messages or an agent's activity while it works.
- **A notification** reads *"Alice mentioned you in Checkout 500s"*, then the
  message's first line, unless **Show message text in notifications** is off on
  that device. Clicking it opens the room.

**Test** (two accounts, three rooms: *Mine*, *With Alice*, *With Bob*):
1. Fede is in *Mine*. Alice writes in *With Alice* without mentioning him: it
   turns bold in his sidebar at once, with no number and no notification.
2. Alice writes `@fede can you check this?`: *With Alice* shows **1**, the tab
   reads `(1) Fabrikka`, and a system notification appears. Clicking it opens
   the room (**1 click**), and the number clears.
3. In *Mine*, Fede mentions his agent and switches to *With Bob*. When the run
   finishes, *Mine* shows **1** and he's notified. The same with the kill
   switch: stopped counts too.
4. In *With Bob*, the agents loop until the budget pauses the room: Fede, who
   can resume it, sees the number. Bob's teammate who can't resume it doesn't.
5. Fede sets *With Alice* to *Nothing* (**2 clicks**: the room's bell, then
   *Nothing*). Alice mentions him again: no bold, no number, no notification,
   and the mention is in *Waiting for you*.
6. A direct chat from Bob notifies on every message, without a mention.
7. In the desktop app, with the window in the background, steps 2 and 3 notify
   through the system and the dock badge shows the total. Quitting the window
   to the tray keeps the tray dot.
8. Turn off **Show message text in notifications**: the next notification says
   who and where, not what.
9. A room Fede can't see never appears on his stream, even when someone types
   his name in it.

**Clicks:** from any room, reaching the room that needs you takes **1** (the
notification, or the sidebar). Muting a room takes **2**. Turning notifications
on is one-time.

## M43 — Team call records expire

> M30 records who used a team's shared connection, and when, for the team's
> owners. It's useful for a while, and nobody needs it forever. A record kept
> forever is the hardest line in a privacy policy to defend.

- **A team setting, *Keep call records for*:** 30, 60, **90** (the default),
  180 or 365 days. Only a team owner changes it, from **Team → Integrations**.
- **Records older than the setting are deleted,** by a job that runs at start
  and then once a day. Shortening the setting deletes the older records on the
  next run, and the selector says so before it's saved.
- **The setting is shown where the records are,** above the list: *"Kept for
  90 days."*
- **Only the call records expire.** Nothing else of the team's changes.

**Test:**
1. A new team keeps call records for 90 days.
2. A team owner opens Team → Integrations → *Keep call records for* → 30 days
   (**3 clicks**). A member sees the value and can't change it.
3. With records 29 and 31 days old, the next run deletes the 31-day one and
   keeps the 29-day one.
4. Another team at 90 days loses nothing.

## M44 — Themes: choose a look, or make one

> People spend hours in a room and want it to look the way they work: a
> terminal, a page, something calm. [ADR 0038](decisions/0038-themes-are-css-packs-checked-by-the-server.md):
> a theme is a folder of CSS with no code; tokens are the contract
> (`docs/themes.md`); the server checks every theme; each person picks theirs.

- **The pack:** `theme.json` (contract, id, name, description, author, license,
  scheme, swatches) and `theme.css`, plus optional fonts and images.
- **The app's stylesheet speaks tokens.** The gradient look's literal values
  become the tokens in `docs/themes.md`; Dusk is their default values.
- **Built in (`themes/`):** Dusk, Dusk Night (today's dark palette, moved out
  of `styles.css`), **Terminal**, **Paper**, **Brutal** and **Aurora**. The four
  new ones differ in type, shape and surface, not only colour.
- **The instance's own:** `FABRIKKA_THEMES_DIR` (`/data/themes` in the image),
  read at start. A bad pack is skipped and the log says why.
- **The server:**
  - `GET /api/themes` (public, so the sign-in page is themed too): each theme's
    manifest, and the default;
  - `GET /themes/<id>/<file>`: only files the check accepted, typed by
    extension, `nosniff`;
  - `GET`/`PUT /api/me/theme`: `{ theme }`, a theme id, `system`, or null for
    the default. An unknown id is refused.
- **The page:** **Appearance** at the bottom of the sidebar opens a grid of
  cards drawn from each theme's swatches, plus *Match my system*. One click
  applies it.
- **No flash:** the choice is cached on the device, and an inline script in
  `index.html` loads the theme's CSS before the app renders. The account's
  choice wins once it arrives.
- **Desktop app:** nothing new. It's the web app.

**Test:**
1. Open Appearance from the sidebar, and click **Terminal** (**2 clicks**). The
   whole app turns monospace and dark at once, with no reload.
2. Reload: it paints as Terminal from the first frame, with no flash of Dusk.
3. Sign in on another browser: it's Terminal there too.
4. Try each of the six: every page stays readable (sidebar, a room, Personal
   integrations, the sign-in page), and Terminal, Paper, Brutal and Aurora look
   unlike each other, not only in colour.
5. Choose *Match my system*, switch the OS to dark: Dusk Night. To light: Dusk.
6. Put a copy of `themes/paper` in the themes directory with `id`
   `paper-copy` and a `url(https://example.com/x.png)` in it, and restart: the
   log says it was skipped and why, and it isn't offered. Remove the URL,
   restart: it's offered, after the built-ins.
7. Nothing outside a pack is served: `/themes/terminal/x.svg` and a missing
   file are 404, and `../` paths never return a file from outside the folder.

**Clicks:** choosing a theme, **2** from anywhere.

## Later — Resuming offline agents

An agent that was mentioned while its runner or host was offline (the laptop
asleep, the app quit) misses the mention today. Mentions queue on the server,
but nothing brings the agent back, and nothing tells the person who mentioned
it what's happening. Wanted:
- **The session shows it plainly:** "@claude-alice is offline. It'll pick this
  up when Alice's laptop is back," instead of silence.
- **When the host reconnects, it picks up the mentions it missed,** in order,
  within the delivery gate and turn budget. Already-answered ones are skipped,
  and ones too old to matter are summarised rather than replayed.
- **Optionally nudge the owner** (the desktop app's notification, later email)
  that their agent has work waiting.
- **A way for the owner to resume it by hand from the web** ("Run now on
  Alice's laptop"), which only works while that computer is online. The
  web never starts anything on a machine by itself.

It needs a decision on what "missed" means across a session that moved on
without the agent, so it gets an ADR first.

## Later — Shared agents on infrastructure the team runs

> Not scheduled. Recorded so that when it comes, it starts from the rule rather
> than around it.

A team wants an agent that belongs to the **team**, not to one person, running
somewhere safe: a VM, a container, a sandbox. This fits the architectural rule
**if the team operates the machine**. The team runs `fabrikka watch` on its own
VM, with the agent runtime it installed and the credentials it chose. The agent
still spawns the bridge, and Fabrikka still installs, updates and supervises
nothing (ADRs 0002, 0011). What's new is an agent whose owner is a team, a trust
tier for team members, and team-scoped credentials. Fabrikka *hosting* that VM
would break the rule, and would need an ADR that supersedes 0002, not one that
extends it.

---

## MVP acceptance

> **Superseded 2026-10-10 by [`docs/mvp.md`](mvp.md)**: the road to MVP, its
> phases (close what's open, the verbs, anyone can bring their agent, anyone can
> host it, open it and launch) and its new acceptance stories for developers,
> students and office workers. The original M8 version is kept below for the
> record.

Run after M8:

1. Create a private session, invite a friend.
2. Attach Claude Code live via the bridge.
3. Attach Codex via spawn-on-mention.
4. Both humans attach their own GitHub + Sentry connections.
5. Work one real problem through the timeline.

**Success = nobody pasted context into an agent.**

Security checks that gate this are listed in `docs/security.md`.

---

## Explicitly not MVP

No built-in LLM provider. No Fabrikka-hosted Claude or Codex. No autonomous orchestration, agent marketplace, workflows, tasks/kanban, shared browser, RAG, vector database, sophisticated memory, public sessions (team-visible sessions, M22, are not public), billing, mobile, enterprise SSO, elaborate RBAC, or local-only execution. Organizations were on this list until 2026-10-03; they are M21 as **teams**, deliberately without billing, SSO or a permission matrix.

## Phase I — the useful problem-solving environment

Structured context, richer artifacts, search across messages/artifacts/decisions, better agent presence UX, per-tool MCP permissions UI. (Session templates and export are now M25 and M27.)

## Phase II — Fabrikka as infrastructure

Local-only sessions on desktop, secure tunnels exposing a local session, optionally hosted agents, and agent-to-agent collaboration built **on top of** the session primitive — never underneath it.
