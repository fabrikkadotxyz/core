# 0036 — Chat apps connect through OAuth, to one endpoint per person

**Status:** Proposed. **Pending the owner's M38 check** (the spike in
`scripts/spikes/m38-connector.mjs`). Its log
answers the open questions at the end, and this ADR is revised before it's
accepted.
**Date:** 2026-10-10
**Supersedes:** [ADR 0009](0009-participant-scoped-tokens.md)'s deferral of OAuth
(its per-session tokens stay exactly as they are).
**Builds on:** [ADR 0001](0001-session-is-an-mcp.md) (the session is an MCP),
`docs/mvp.md` (Phase 2, M38) and the trust model in `docs/security.md`.

## Context

The MVP has to work for people without a terminal: students, academics, office
workers (`docs/mvp.md`). They already have an agent, Claude or ChatGPT in the
browser or desktop app, and both apps take **remote MCP connectors**. Fabrikka
is an MCP server, so in principle any of them can join a room.

Two things stand in the way:

1. **Authentication.** A connector in claude.ai or ChatGPT signs in with OAuth.
   It discovers the server's metadata, registers itself and sends the person
   through a consent page. Neither app takes a pasted bearer token. Fabrikka
   has no authorization server: ADR 0009 deferred one until "sessions are
   shared across trust domains", and deliberately serves no OAuth metadata.
2. **Shape.** Every endpoint today is one session (`/mcp/o/{owner}/s/{session}`),
   with a token per `(session, participant)`. A connector is added once, in
   the chat app's settings, so one connector per room would mean one setup per
   room. That fails the five-click rule (`CLAUDE.md`).

ADR 0009 also rejected exactly the shape a connector needs: *"a user-scoped API
key plus a session id in the request … the session becomes a parameter rather
than a scope, so a bug in one check exposes everything."* That argument still
holds for agents on someone's machine. This ADR has to say why a connector is
different, and what replaces the scope.

ADR 0009 also notes that MCP's 2026-07-28 revision moves from dynamic client
registration toward **Client ID Metadata Documents**, and asks for RFC 9207
issuer validation. Which of the two each chat app uses is one of the spike's
questions.

## Decision

**Fabrikka becomes an OAuth 2.1 authorization server for one new, per-person
MCP endpoint. A person connects their chat app once, and its assistant can then
work in every room that person is in, as a participant identified as their
connector. Per-session tokens and the existing lanes don't change.**

### The authorization server, on the instance's own origin

- **Protected-resource metadata** (RFC 9728) for the per-person endpoint, and
  **authorization-server metadata** (RFC 8414). The issuer is the instance's
  `PUBLIC_URL`. A self-hosted instance is its own issuer, with no outside
  identity provider.
- **Clients:** dynamic client registration (RFC 7591), **and** Client ID
  Metadata Documents where a client uses them. Redirect URIs must be `https`,
  or loopback for desktop clients. Registered clients are kept, and a person
  sees them by the name they registered with.
- **Authorization code with PKCE, S256 only.** The authorization response
  carries `iss` (RFC 9207). The resource indicator (RFC 8707) binds every token
  to the per-person endpoint: a token issued for anything else is refused.
- **The consent page** is a Fabrikka page behind the normal login. It names
  the account (*"Connect Claude to Fabrikka as fede@example.com"*), lists what
  the connector will be able to do, and has one **Allow** button. A person who
  isn't signed in signs in first. That's the existing login, not a second one.
- **Scopes,** shown on the consent page in plain words:
  - `rooms:read`: list your rooms, and read their messages, context and files;
  - `rooms:write`: post messages, add to a room's context, and add files.

  **Nothing else, ever, through a connector:** no account settings, invites,
  membership, teams, integrations' credentials or admin. The connector's reach
  is the person's rooms, not the person's account.

### Tokens: a new kind, scoped to a person

- **Opaque, random, stored hashed** (SHA-256), like session tokens and logins.
  Not JWTs: revocation must be immediate (ADRs 0007, 0009).
- **An access token lives 1 hour. A refresh token rotates on every use** and
  expires after 30 days unused. Presenting a refresh token that was already
  rotated revokes the whole grant: that's a stolen token being replayed.
- **A connector token is never valid on a per-session endpoint**, and a session
  token is never valid on the per-person one. They're separate tables with
  separate lookups, so neither can be mistaken for the other.

### The per-person endpoint: the room is a parameter, checked like the web app

One endpoint per instance (the path is an open question; candidates are
`/mcp` and `/mcp/me`). The token says who the person is, and every tool names
its room:

| Tool | Scope | Does |
| --- | --- | --- |
| `whoami` | read | Which person and which connected app this is |
| `list_rooms` | read | The rooms this person can see now, with their references (`owner/session`) |
| `read_room` | read | One room's title, objective, decisions, open questions and recent messages |
| `read_messages` | read | Older messages, as the per-session tool does |
| `list_files`, `read_file` | read | The room's artifacts, as `list_artifacts`/`read_artifact` |
| `post_message` | write | Post as this connector, optionally mentioning someone |
| `add_to_context` | write | Append a fact, decision or open question (append-only, as `update_session_context`'s `add_*`) |

**Why a parameter is acceptable here, when ADR 0009 refused it for agents:**

- **The reach isn't new.** A connector reaches what its person's browser login
  already reaches, and less: rooms only, never the account. ADR 0009's worry
  was an *agent's* credential reaching more than its one session. A connector
  is the person's own assistant, working for that person, so person-wide is
  its correct scope.
- **The check is the one the web app already makes.** Every tool resolves its
  room through the same function the web API uses for that person
  (`resolveSessionForUser`, and `resolveSessionForViewer` where a viewer may
  read). There's no second, connector-only access path to get wrong.
  - A room the person can't see is a **404, as on the web** ("existence is
    private"). The tool answers *no such room*, whether it doesn't exist or
    isn't theirs.
  - A **viewer** (M22) gets read tools only in rooms where they're a viewer,
    and `post_message` there is refused the same way the web refuses it.
- **Tokens are short-lived and rotating, unlike session tokens,** to make up
  for the wider reach.

### Who the connector is in a room

- **The first time the connector works in a room,** the server adds it as a
  participant: kind `agent`, owner = the person, named after the client, e.g.
  *"fede's Claude (connector)"*. Every member sees it arrive, like any agent
  (M17's markers). A second connected app (ChatGPT) is a second participant.
- **The trust tiers apply unchanged** (`docs/security.md`).
  - What the connector posts is authored by it, never by the person, and is
    untrusted to every other agent. Its mention of `@claude-fede` doesn't make
    Claude Code act. Only a human's mention can, under that agent's trust
    tier.
  - Only its own person directs it, and they do that in their chat app, not in
    the room.
- **M6's rails:**
  - The turn budget counts deliveries, and a connector receives none (below).
    Its writes don't count against it.
  - A connector's writes are rate-limited per person per room instead, and the
    kill switch pauses its writes like any participant's.
  - A paused room refuses `post_message` with the reason.

### What Fabrikka can and can't control about prompt injection

A connector brings room content into a model that sits beside the chat app's
**other** connectors and tools: the person's email, drive, calendar. A message
planted in a room could try to make that model send something out through
another tool. That's a different exposure from an agent on someone's machine.

**What Fabrikka does:**
- Content is read only when a tool is called. Nothing is pushed into the chat
  app.
- **Every message returned carries its author and its `trust` value,** wrapped
  and labelled as untrusted data, as the bridge does.
- **The write tools are declared as such** in their MCP annotations, so an app
  that asks before writing will.
- **No tool ever returns a credential or a link that grants access.**
- **The consent page says it in plain words:** this assistant will read what
  people write in your rooms.

**What Fabrikka can't do:**
- control what the chat app's model does with what it read;
- control which other tools sit beside it;
- control whether the app asks before acting.

Those belong to the chat app and to the person. `docs/security.md` gets a
threat section saying so.

### Revocation

**Settings → Connected apps** lists each app: its registered name, when it was
connected, when it was last used, and its scopes. **Disconnect** revokes the
grant: every access and refresh token, immediately. The app's participants stay
in their rooms' history, marked disconnected. Resetting a password revokes every
connected app, as it ends every login.

### Clicks

- **One-time setup** (allowed to take longer, once):
  1. In the chat app: open the connectors settings, add a custom connector, and
     enter the instance's connector URL. That URL is the one paste, once.
  2. Sign in to Fabrikka if needed, then **Allow** (1 click in Fabrikka).
  3. Done for every room, present and future.

  Fabrikka's *Connect your Claude* page (M17) shows the URL with a copy
  button. If an app supports a link that pre-fills its connector form, the
  paste disappears (an open question).
- **Per use: zero clicks.** In any room, the person asks their assistant:
  *"what did we decide in the checkout room?"*

## The honest limits, said in the room

- **No spawn on mention.**
  - A connector agent acts only when its person prompts it in their chat app.
    A mention of it in the room is stored like any mention and waits.
  - The room says so beside its name: *"Answers when fede asks it."* This is
    the same honesty as steering's (ADR 0016).
  - The person's *Waiting for you* (M24) still shows the mention.
- **The instance must be reachable from the internet.**
  - The chat apps connect from their own servers.
  - An instance behind a VPN, or on `localhost`, can't take connectors. Its
    people use the desktop app or lane A.
  - Hosted and public self-hosted instances are fine (`docs/mvp.md`).
- **The model is the chat app's.** It's still the person's agent, under their
  account (PRINCIPLES.md, promise 2): Fabrikka runs no model and holds no
  model key.

## Open questions the spike answers

The owner's check logs, for claude.ai, Claude Desktop and ChatGPT:

1. **The `resource` value** each sends at authorize and token: the endpoint URL
   exactly, the origin, or nothing. That decides the RFC 8707 check.
2. **Which metadata paths** each requests (path-suffixed or not, OpenID
   configuration), so we serve only those.
3. **Registration:** dynamic registration or a Client ID Metadata Document, and
   what redirect URIs each registers.
4. **Does either need MCP session IDs or the server-to-client stream** (GET),
   or does each work statelessly, as the per-session endpoint does?
5. **Which plans allow custom connectors** (free, Pro, Team, Enterprise; and
   ChatGPT's developer mode), so M17 can say up front who can use this path.
6. **How each shows tool results, and whether it asks before writing.** This
   affects the tool descriptions and the trust labelling.
7. **Whether either app accepts a link that pre-fills a connector** (the setup
   paste).

## Consequences

- **Follow-up docs, in the same change as the code:**
  - `docs/protocol.md`: the per-person endpoint, its tools, the scopes, and the
    metadata. A new section, because it's a public contract.
  - `docs/security.md`: the connector threat section, the token rules, and a
    release-gate check (a connector token can't reach a room its person can't
    see).
  - `docs/data-model.md`: the new tables.
  - The M38 spec in `docs/roadmap.md`: the test with real accounts, and its
    click count.
- **New tables:**
  - `connector_clients`: registered apps.
  - `connector_grants`: a person's consent per client, and its scopes.
  - `connector_codes`: authorization codes, single-use.
  - `connector_tokens`: access and refresh, hashed, with rotation lineage.
  - Named apart from M18's `oauth_clients`, which records Fabrikka as a
    *client* of vendors: the opposite direction.
- **ADR 0009's static per-session tokens stay** for agents on machines, scripts
  and CI. The OAuth metadata is served only for the per-person endpoint. The
  per-session endpoint keeps answering a missing token with a bare
  `WWW-Authenticate: Bearer`, so Claude Code isn't sent into a flow that the
  per-session endpoint doesn't offer.
- **M17's first run gains a path:** an invitee without a terminal agent is
  offered *Connect your Claude* instead of lane A.

## Alternatives considered

- **One connector per room.** It keeps ADR 0009's per-session scope exactly.
  But setting up a connector per room fails the five-click rule, and a chat
  app's connector list would fill with rooms.
- **Paste a static token into the chat app.** Neither app supports it for
  remote connectors, and a paste per room or per person is the failing design
  the rule names.
- **An external identity provider** (Auth0, Keycloak, a cloud IdP) as the
  authorization server. That's less code here, but one more service every
  self-hoster has to run and configure, and an outside party in every
  sign-in. The instance is already the identity provider for its own logins.
- **Expose the person's whole account through the connector,** with invites,
  settings and integrations. More capable, but a connector's credential then
  reaches everything a login does, from a model sitting beside other tools.
  Rooms only.
