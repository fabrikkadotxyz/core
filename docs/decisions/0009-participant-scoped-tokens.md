# 0009 — Session tokens are participant-scoped, and OAuth is deferred

**Status:** Accepted
**Date:** 2026-09-27

## Context

M3 opens the session to external agents over MCP. Something has to answer: *who
is this request, and what may it see?*

The security boundary is already fixed by ADR 0001 and `docs/security.md`: a
credential is scoped to one session, and the same agent identity in two sessions
implies no access between them. What M3 has to decide is the shape of that
credential.

MCP's own authorization story points at OAuth. The 2026-07-28 revision hardened
it considerably — RFC 9207 issuer validation, a move from Dynamic Client
Registration toward Client ID Metadata Documents, credentials bound to their
issuing authorization server. Both agents we care about implement it: Claude Code
supports OAuth 2.0 with DCR and pre-configured credentials, Codex does
authorization-code + PKCE with tokens in the system keyring.

But both also accept a static bearer token via a header, and Fabrikka has no
authorization server. Standing one up is a project in itself, and it buys nothing
until sessions are shared across trust domains.

## Decision

**A session token identifies a `(session, participant)` pair — an actor, not a
user — and is presented as a static bearer token. OAuth is deferred, and no
protected-resource metadata is served until an authorization server exists.**

```
session_tokens
  session_id      -- the only session this token can reach
  participant_id  -- the actor it speaks as
  token_hash      -- SHA-256; plaintext shown once, never recoverable
  label           -- "claude-fede on my laptop"
  expires_at      -- nullable: agents are long-lived
  revoked_at
  last_used_at
```

Scoping to a **participant** rather than a user is what makes the rest of the
system work. The token *is* the agent's identity in that session:

- A message posted with it is authored by that participant, so authorship cannot
  be spoofed by the request body.
- `@claude-fede` and `@claude-alice` are different participants and therefore
  different tokens, which is how the spec's multiple-agents case falls out.
- Trust evaluation (M6) keys on the participant, so it needs no extra lookup.
- Revoking one agent's access does not touch another's.

### Why no OAuth metadata yet

The tempting move is to serve protected-resource metadata now, since the SDK
offers `buildOAuthProtectedResourceMetadata` and `oauthMetadataResponse`, and
leave the flow for later. **We deliberately do not.**

Claude Code treats a `401` or `403` as "this server needs authentication" and
begins discovery. Advertising metadata that names an authorization server which
does not exist would send every client into a flow that cannot complete, and the
failure would look like a Fabrikka bug rather than a missing feature. A plain
`401` with `WWW-Authenticate: Bearer` says exactly what is true: present a token.

When there is a real authorization server, metadata gets served and the static
path stays for scripts and CI. Nothing here has to change for that to happen.

### Failures are uniform 404s

Three checks run before the MCP handler, in order, each failing to **404**:

1. The token is valid, unrevoked and unexpired.
2. The token's `session_id` matches the path's `session_id`.
3. The path's `owner_id` matches that session's owner (ADR 0006).

A **missing** token is the one case that answers `401`, because "you presented no
credential" is not information about whether anything exists. A *wrong* token
must not be able to distinguish a real session from an imaginary one.

## Consequences

- Setup is one `claude mcp add --header "Authorization: Bearer …"`. No browser
  flow, no client registration, nothing to configure server-side.
- The token is a long-lived bearer credential in a config file. Mitigated by
  per-session scope, revocability, `last_used_at` for noticing stale tokens, and
  showing the plaintext exactly once. It is strictly less dangerous than the
  provider API keys already sitting in the same files.
- No refresh, no rotation, no expiry by default. Revocation is the only control,
  so the UI must make listing and revoking tokens easy.
- Nothing about the tool surface depends on this choice, so adding OAuth later is
  additive rather than a migration.
- `session_tokens` is a second credential table beside `auth_sessions`. They stay
  separate on purpose: a browser login is a *user* acting across sessions, an
  agent token is a *participant* inside exactly one. Merging them would mean one
  table with two meanings and a nullable column deciding which.

## Alternatives considered

**Full OAuth now.** Correct long-term, and what the spec pushes toward. Rejected
for the MVP: it requires an authorization server, client registration and issuer
validation before a single agent can join, and the MVP's question is whether the
session model is useful at all.

**Reuse the browser login cookie.** No new table, and an agent would act as the
user. Rejected: a cookie is not scoped to a session, so one leaked credential
would expose every session that user belongs to — the opposite of ADR 0001's
boundary. It also gives an agent no distinct identity, collapsing `@claude-fede`
into `@fede`.

**A user-scoped API key plus a session id in the request.** One credential per
user, simpler to issue. Rejected: the session becomes a *parameter* rather than a
scope, so a bug in one check exposes everything. Scope belongs in the credential.

**Signed stateless tokens (JWT).** No lookup per request. Rejected for the same
reason as `auth_sessions` (ADR 0007): revocation has to be immediate, and an
agent token that cannot be killed instantly is worse than a session cookie that
cannot.
