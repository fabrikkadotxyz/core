# Roadmap

Milestones are **sequential**. Each ends in something manually exercisable. Do not start the next one until the current one's test passes.

The MVP answers one question: *does it feel useful to have a private room where I work with my existing agents and other people?*

---

## M0 — One message, end to end

Monorepo, Hono server, Postgres via `docker/`, Drizzle schema for `users` / `sessions` / `participants` / `messages`, WebSocket event bus, React timeline. One hardcoded session, no auth.

**Test:** Open two browser tabs on the same session. Type in one, see it in the other. Refresh — history persists.

## M1 — Auth, real sessions, privacy

Email/password auth, session CRUD (create / rename / archive), `session_members`, invite by email.

**Test:** Sign up two users. Fede creates a session and invites Alice; both see it. A third account hitting the session URL gets **404, not 403** — existence is private.

## M2 — Participants and mentions as first-class

Unify humans and agents behind `participants`. Mention autocomplete resolving to a `participant_id` and writing `message_mentions` — **not** text parsing at read time.

**Test:** Type `@ali`, pick Alice, send. A `message_mentions` row exists in the DB. Rename Alice's display name — the old message still resolves to her.

## M3 — Remote session MCP endpoint (lane A) — *first real payoff*

`/mcp/o/{owner_id}/s/{session_id}` via `createMcpHandler` + `createMcpHonoApp`. Bearer token verified in front of the handler, passed as `handler.fetch(req, { authInfo })`. `oauthMetadata` middleware for protected-resource metadata. Tools: `get_session_context`, `list_participants`, `read_messages`, `post_message`. Static session tokens; OAuth later.

**Test:**
```bash
claude mcp add --transport http fabrikka \
  https://<host>/mcp/o/<owner_id>/s/<session_id> \
  --header "Authorization: Bearer <token>"
```
Ask Claude to read the session and post a summary; it appears in the browser attributed to `@claude-fede`. Confirm a token for session A returns nothing for session B, and a wrong `owner_id` returns 404.

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

## M7 — Session context + artifacts

`session_context` editable in the UI, exposed via `get_session_context` / `update_session_context`. File upload and link artifacts, listed over MCP.

**Test:** Fede writes an Objective in the browser; Claude reads it via MCP without being told. Claude appends a Decision; it renders in the browser. Upload a CSV; Claude lists and reads it.

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
