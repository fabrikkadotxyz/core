# Roadmap

Milestones are **sequential**. Each ends in something manually exercisable. Do not start the next one until the current one's test passes.

The MVP answers one question: *does it feel useful to have a private room where I work with my existing agents and other people?*

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

Members attach their own external MCP servers. Session endpoint proxies them with namespaced names (`github__create_issue`). Calls route to the **calling participant's** credential. Unattached servers are absent from that participant's tool list. Tool-level, default-deny grants. Read-only to start.

**Test:** Fede attaches GitHub, Alice does not — Fede's agent lists GitHub tools, Alice's does not. Alice attaches her own; her calls appear in GitHub's audit log as **Alice**. Deny `create_issue` and confirm it vanishes from the tool list.

## M9 — Tauri desktop

Wrap the web app with Tauri 2.11.5; build and sign for macOS / Windows / Linux. No new product surface — this is packaging. Sequenced last deliberately: at MVP a desktop build wraps the same web app, and the things desktop uniquely enables (local MCPs, local files, local-only sessions) are Phase II.

**Test:** Install the macOS build, sign in, join a session, confirm realtime and MCP behave identically to the browser.

---

## MVP acceptance

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

No built-in LLM provider. No Fabrikka-hosted Claude or Codex. No autonomous orchestration, agent marketplace, workflows, tasks/kanban, shared browser, RAG, vector database, sophisticated memory, public sessions, organizations, billing, mobile, enterprise SSO, elaborate RBAC, or local-only execution.

## Phase I — the useful problem-solving environment

Structured context, richer artifacts, search across messages/artifacts/decisions, better agent presence UX, per-tool MCP permissions UI, session templates, session export to Markdown/JSON.

## Phase II — Fabrikka as infrastructure

Local-only sessions on desktop, secure tunnels exposing a local session, optionally hosted agents, and agent-to-agent collaboration built **on top of** the session primitive — never underneath it.
