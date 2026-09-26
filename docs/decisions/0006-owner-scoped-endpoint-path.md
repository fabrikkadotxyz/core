# 0006 — Owner-scoped MCP endpoint path

**Status:** Accepted
**Date:** 2026-09-26

## Context

ADR 0001 established that every session exposes an MCP endpoint. The original shape was:

```
https://<host>/mcp/s/{session_id}
```

The session id alone is sufficient to identify the session, and the bearer token is already scoped to it, so the owner is strictly derivable. The question is whether to surface it anyway.

Arguments for surfacing it: the endpoint becomes self-describing in an agent's config, in logs and in support conversations; it gives a routing and sharding key available before any database lookup; and it scopes session ids to an owner, so they never need to be globally unique.

Arguments against: it is redundant with the token, it puts a user identifier into files that get committed and logs that get shipped, and it pins the URL to an owner that may change.

## Decision

**Include the owner in the path, as a public slug, validated on every request.**

```
https://<host>/mcp/o/{owner_id}/s/{session_id}
```

Three properties make this safe rather than decorative:

1. **It is a public slug, never the internal `users.id`.** This URL lands in `.mcp.json` files, shell history, CI logs and committed repositories. A stable public handle belongs there; a database primary key does not. `users.owner_slug` exists for this.

2. **It is validated, and a mismatch is a 404.** If `owner_id` does not match the session's actual owner, the response is 404 — identical to a non-existent session, consistent with "existence is private" (`docs/security.md`). A path segment that can be wrong without consequence is worse than no path segment at all, because it trains everyone to ignore it.

3. **It is never an authorization input.** Three checks run before the MCP handler, in order, each failing to 404: the token is valid; the token's session matches the path's session; the path's owner matches the session's owner. The third can only ever *reject* a request the first two admitted. It grants nothing, so a forged or guessed `owner_id` gains an attacker exactly nothing.

## Consequences

- **Ownership transfer invalidates every agent config pointing at the session.** This is the real cost. Ownership transfer is not in the MVP; when it lands it must ship with a redirect from the old path, not a silent 404. Recorded here so it is not discovered by a user.
- A public slug namespace now exists and needs uniqueness, reservation of system-sounding names, and a rename policy. Renaming an owner slug has the same breaking effect as transfer and needs the same redirect treatment.
- Session public ids only need to be unique per owner, not globally.
- Routing and rate-limiting can key on the owner segment without a lookup.
- One more thing that can be wrong in a hand-typed URL, mitigated by the UI always generating the full command to copy.

## Alternatives considered

**`/mcp/s/{session_id}` only.** Shortest, no redundancy, immune to ownership transfer. Rejected: opaque in logs and configs, and gives up a free routing key. The transfer problem is real but is a future feature that can carry its own redirect, whereas legibility is wanted immediately.

**Raw `users.id` in the path.** Rejected outright — an internal primary key leaked into committed files and logs for no benefit a slug doesn't also provide.

**Owner as a subdomain (`{owner}.fabrikka.dev/mcp/s/{id}`).** Better isolation story, and a natural boundary for cookies and CORS. Rejected for the MVP: wildcard TLS, DNS provisioning and local-dev friction are real cost for a benefit we don't need until multi-tenant hosting is a concern. Worth revisiting then; this ADR would be superseded.

**Owner in a header instead of the path.** Keeps URLs short and stable. Rejected: headers are invisible in the places the legibility benefit is wanted, and `claude mcp add` configs already carry the token header — adding a second one is more setup surface, not less.
