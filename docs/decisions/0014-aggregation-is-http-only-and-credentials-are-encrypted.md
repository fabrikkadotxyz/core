# 0014 — Aggregated servers are HTTP-only, and credentials are encrypted or refused

**Status:** Accepted
**Date:** 2026-09-28

## Context

M8 lets a session attach external MCP servers — GitHub, Sentry, Postgres — and
presents them through the session's own endpoint, so an agent needs one connection
instead of four. [ADR 0004](0004-per-participant-credentials.md) already settled
*whose* credentials get used: the calling participant's, never the session's.

What it did not settle is two things that only matter once you try to build it.

**First: Fabrikka starts holding other people's secrets.** Until now the project
has stored exactly one class of credential — its own session tokens, hashed, and
therefore worthless if the database leaks. A GitHub token cannot be hashed. It has
to be *recoverable*, because the server presents it upstream. That is a different
kind of thing to own, and it deserves to be decided rather than drifted into.

**Second: MCP servers come in two shapes.** Remote HTTP, and local stdio launched
by a command. Supporting stdio would mean the Fabrikka server executing
arbitrary commands with arbitrary arguments from a database row. On a self-hosted
box that is merely the user's own machine. On hosted infrastructure it is remote
code execution as a feature.

## Decision

### Only remote HTTP servers are aggregated

A `session_mcp_server` is a streamable-HTTP endpoint and a bearer credential.
**Command-launched stdio servers are not supported here, and the API refuses
them.**

The reasoning is the same one behind ADR 0002: we do not run other people's
processes. A stdio MCP server is a program someone wants executed, and the place
for that is the user's own machine — which is exactly where the **bridge** already
runs. A local stdio server belongs to a local agent's own `.mcp.json`, or to
Phase II's local-MCP support on the desktop app. It does not belong in a row in
our database.

This also keeps the failure modes sane. A misbehaving HTTP server returns a bad
response; a misbehaving subprocess can eat the server's file descriptors, block on
stdin forever, or outlive the request that started it.

### Credentials are encrypted at rest, and refused if they cannot be

Credentials are sealed with **AES-256-GCM** using a key supplied by the operator
as `FABRIKKA_ENCRYPTION_KEY` (32 bytes, base64). Each record carries its own
random IV and auth tag.

**If no key is configured, attaching a credentialed server fails.** The feature
becomes unavailable rather than quietly storing tokens in plaintext. A deployment
that has not thought about key management does not get to accumulate other
people's GitHub tokens by accident.

Consequences accepted deliberately:

- Losing the key makes stored credentials unrecoverable. That is the correct
  failure: they are re-attachable in a minute, and the alternative is a key that
  is not really protecting anything.
- The key lives in the environment, so it is as safe as the deployment's secret
  handling. We are not building a KMS abstraction for an MVP, but the sealed
  format carries a version byte so one can be introduced without a migration.
- A credential is **never** returned by any read API, and never logged. The UI
  shows only whether one is set.

### Grants are per session and per tool, keyed by the integration's slug

`session_mcp_tool_grants(session_id, server_slug, tool_name, allowed)`, and the
default is **deny**.

Keyed by the **slug** (`github`), not by the `mcp_servers` row. Fede and Alice each
attach their own GitHub with their own token — two rows, one integration. What the
*session* permits is a property of the session, not of whose token happens to be
behind it: "GitHub read but not merge, in this room" should mean the same thing
regardless of who is asking.

This differs from the shape sketched in `docs/data-model.md` at M0, which keyed
grants by `mcp_server_id`. That would have meant re-granting every tool for every
member who attached the same integration, and a session where Alice could merge
because nobody had got round to denying it on *her* row.

Default-deny also answers the tool-count problem: a session with GitHub, Sentry,
Slack and Postgres attached could otherwise put 100+ tool definitions in front of
an agent before it does anything, against a 25 000-token output cap. An explicitly
granted handful is both safer and smaller.

## Consequences

- A whole class of integration — local stdio servers — is out of scope here, and
  the API says so rather than half-working.
- Deployments must set `FABRIKKA_ENCRYPTION_KEY` before aggregation works. That
  is one more setup step, and it is the right one to require.
- Granting is per tool, so attaching GitHub gives an agent nothing until someone
  chooses what it may do. More friction, and the friction is the feature.
- Different participants see different tool lists in the same session, because a
  server nobody attached is absent rather than present-and-denied. The UI has to
  make that legible rather than confusing.
- We now have a key to rotate. Sealed values carry a version byte so a re-seal
  can happen in place later.

## Alternatives considered

**Support stdio servers too.** Matches what MCP users actually have configured
locally, and would make GitHub-via-`npx` work. Rejected: it turns the server into
an arbitrary-command executor driven by database rows. The bridge already runs on
the user's machine and is the right home for local servers.

**Store credentials in plaintext and rely on database access control.** Simpler,
and honest about the fact that a compromised database is bad regardless. Rejected:
encryption at rest is the difference between a leaked backup being an incident and
being a catastrophe, and "the database was already compromised" is not a reason to
hand over every user's GitHub token as well.

**Never store credentials — proxy with a per-request token from the caller.**
Genuinely the most secure option: we would hold nothing. Rejected because the
caller is an *agent*, and the point is that the agent should not need to hold
four separate credentials — that is the whole reason aggregation exists.

**Session-owned credentials with per-tool grants.** Far simpler: one token per
integration per session. Rejected by ADR 0004, and nothing here changes that
reasoning — it silently converts "I invited you" into "I gave you my write token".
