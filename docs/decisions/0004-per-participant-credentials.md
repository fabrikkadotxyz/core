# 0004 — MCP credentials are per-participant

**Status:** Accepted
**Date:** 2026-09-25

## Context

A session aggregates external MCP servers — GitHub, Sentry, Slack, Postgres — and presents them through the session's own endpoint, so an agent needs one connection instead of four.

That raises a question the original spec left open: **when Alice's agent calls `github__create_issue` in Fede's session, whose token is used?**

The simple answer is "the session's" — the owner attaches GitHub, everyone in the session uses it. It is fewer steps to a working demo. It is also a textbook confused deputy:

- Inviting someone to a session silently grants them your write access.
- Every action in GitHub's audit log is attributed to **you**, including actions you didn't take and can't see.
- Revoking access means removing them from the session, which is far too coarse.

"I invited you to a room" must not mean "I gave you my write tokens."

## Decision

**Credentials belong to a user, not to a session. A tool call routes to the *calling participant's* credential.**

- Each member attaches their own external MCP connections (`mcp_servers.owner_id`).
- A session lists which servers are available (`session_mcp_servers`).
- At tool-list time, a participant sees only servers **they** have attached. Servers they haven't attached are **absent**, not present-and-denied — presence leaks the session's topology.
- Grants are **tool-level and default-deny** (`session_mcp_tool_grants`). Server-level granularity cannot express "GitHub read but not merge", which is the actual requirement.

```
Session "Debug Stripe webhook"
  github:  fede  ✓ (fede's token)
           alice ✓ (alice's token)
  sentry:  fede  ✓
           alice ✗  → sentry tools not listed for alice

alice's agent calls github__*  →  alice's token
GitHub audit log says: alice
```

## Consequences

- Per-user setup friction: each member attaches their own connections before their agent can use them. This is the cost, and it is worth paying.
- Audit logs in external systems are correct. This matters more than it looks — it is the difference between "we can investigate what happened" and "everything was fede".
- Different participants see different tool lists in the same session. The UI has to make that legible rather than confusing.
- Removing a member removes their credentials from the session automatically, because the credentials were never the session's.
- Aggregated tool count is naturally bounded per participant, which partly mitigates context bloat from tool definitions.

## Alternatives considered

**Session-owned credentials.** The owner attaches GitHub, everyone uses it. Much simpler, fewer steps to a demo. Rejected: it converts session membership into credential sharing, silently, and destroys audit attribution.

**Read-only aggregation for the MVP.** Session-owned credentials but no write tools, deferring the authz question. Genuinely tempting, and it would have been safe. Rejected because the schema and routing shape differ between the two models, and retrofitting per-participant routing after the fact means rewriting the proxy layer and migrating stored credentials. The friction is front-loaded either way; better to pay it before anything depends on the wrong shape.

**Per-session service accounts.** A bot identity per session holding its own tokens. Rejected: it reintroduces the attribution problem one level up, and it means provisioning real accounts in every external system.
