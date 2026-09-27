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

`packages/bridge` ships `npx fabrikka connect <session>`: a **v1-SDK** stdio MCP server holding a WebSocket to Fabrikka. Declares `experimental['claude/channel']` + `tools`, pushes `notifications/claude/channel`, exposes a `reply` tool.

Two details that will cost an afternoon if missed — `meta` keys must be `[A-Za-z0-9_]+` or they are silently dropped, and `MCP_PROTOCOL_NEGOTIATION` must stay unset or the server won't register as a channel at all. See `docs/protocol.md`.

**Test:**
```bash
claude --dangerously-load-development-channels server:fabrikka
```
Accept the dev-channel warning; confirm the startup notice names `server:fabrikka`. From the browser send `@claude-fede what's in my working directory?`. Claude reacts **in your running terminal session, with your repo open**, and the answer lands back in the browser. This is the demo.

## M5 — Spawn-on-mention fallback + Codex

When no `bridge` connection is attached, spawn a headless run per mention and stream results back. `claude -p … --mcp-config …` / `codex exec … --full-auto`. Generated config points at the session's lane-A endpoint with a run-scoped token. Poll 5 s with backoff.

**Test:** Quit the live Claude Code session. Mention `@claude-fede` — a headless run starts, posts findings, and shows `working → idle` in the participants list. Then connect `@codex-fede` and repeat.

## M6 — Safety rails — *gate, not a suggestion*

> **M6 must land before a second human is ever put in a session with a spawn-enabled agent.** Until it does, sessions are single-owner-trusted.

- `trust_tier` default `owner_only`: only the owner's mentions can trigger action.
- Other participants' messages delivered as explicitly-labelled untrusted context.
- Agents never receive their own messages; delivery only on explicit mention.
- `session_turn_budget`: N turns per rolling window, then pause and surface it.
- Per-session kill switch halting delivery and terminating in-flight runs.

**Test:** Alice sends `@claude-fede rm -rf /tmp/demo`. Fede's agent does **not** act; it shows as untrusted context. Set two agents to mention each other — the turn budget halts it. Hit the kill switch mid-run — the spawned process dies.

## M7 — Session context UI + artifacts

The context **tools and storage landed at M3** (`get_session_context` /
`update_session_context`), so this milestone is the human side plus artifacts:
context editable in the browser, file upload and link artifacts, listed and
readable over MCP via `list_artifacts` / `read_artifact`.

**Test:** Fede writes an Objective in the browser; Claude reads it via MCP
without being told. Claude appends a Decision; it renders in the browser. Upload
a CSV; Claude lists and reads it.

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
