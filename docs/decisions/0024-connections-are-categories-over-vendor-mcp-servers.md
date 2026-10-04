# 0024 — Connections are categories over vendors' own MCP servers

**Status:** Proposed
**Date:** 2026-10-03

## Context

The stories behind M18–M27 need a session to reach a code host, an issue tracker,
an observability tool and a docs wiki. They also need it to work the same whether
the team uses Jira, Linear or ClickUp. Teams don't pick tools to suit us, and a
product that only works with Jira has chosen its customers for them.

M8 already aggregates any streamable-HTTP MCP server, with per-user sealed
credentials (ADRs 0004, 0014) and default-deny per-tool grants. Two things stop
it from serving these stories:

1. **Connecting is a URL and a pasted token.** Nobody on a non-engineering team
   will do that, and it's a poor experience for engineers too.
2. **Most vendors' remote MCP servers authenticate with OAuth**, which M8 doesn't
   speak. For them, connecting is impossible today, not just awkward.

The question this ADR answers is *where* the vendor-agnosticism lives.

## Decision

**Fabrikka is agnostic at the category level and writes no vendor adapters.
A connection is the vendor's own MCP server, offered under a category; agents
use the vendor's tools directly.**

- **The catalogue** lists entries by category: code host, issue tracker,
  observability, docs. **An entry is one file**, `connections/catalogue/<vendor>.ts`,
  plus one line in the catalogue registry, the same shape as output kinds (ADR
  0023). It is data: the vendor's name, category, icon, MCP endpoint, auth method
  (OAuth or token), the OAuth client's environment variable names if it needs a
  pre-registered one, and which tools each grant preset covers. **Adding a vendor
  means adding that file and that line. No other code changes.** As with kinds, a
  test fails if a vendor's slug appears anywhere else.
- **OAuth follows the MCP authorization spec**: protected-resource discovery,
  dynamic client registration where the vendor supports it, a pre-registered
  client where it doesn't, and PKCE. Redirects go to the instance's own origin,
  so `localhost` works with no domain.
- **The same code serves a hosted instance and an organization's own instance.**
  There is no deployment-mode flag (ADR 0007). An entry that needs a
  pre-registered client is offered when that client is configured, and is absent
  otherwise. A hosted instance registers one client per vendor once, so its
  users just click *Connect*. A self-hosted instance gets every vendor that
  supports dynamic registration with no setup at all, and the rest once its
  operator registers a client.
- **Credentials are unchanged.** Tokens are per user, sealed under
  `FABRIKKA_ENCRYPTION_KEY`, refused without it, never returned (ADRs 0004,
  0014). A refresh token is a credential like any other.
- **Grant presets** (*Read*, *Read & write*) expand to M8's per-tool grants, using
  the entry's tool lists. The enforcement point stays per tool and default-deny.
  A tool the entry doesn't classify isn't in any preset, and has to be granted by
  name.
- **Verified, not documented.** A vendor gets a catalogue entry only after it has
  been connected for real, the way M16 treats Cursor. An unverified vendor is
  absent; *Custom connection* remains for everything else.
- **Stdio-only vendors** can't be connected through the session (ADR 0014). Their
  entry says so and gives the snippet for the user's own agent config.

What Fabrikka *does* model in a vendor-neutral way is the session's own record
of outside things: **links** (M19), `{ type, provider, url, title, status }`. That
is the part Fabrikka itself has to understand, to show it and export it, and
it's small enough to stay honest across vendors.

## Consequences

- Switching from Jira to Linear changes which catalogue entry a team picks, and
  nothing else in Fabrikka. The agent adapts, because it reads the vendor's tool
  descriptions. That's the property the stories ask for.
- We inherit each vendor's MCP server as it is: its quality, its tool names, its
  outages. A vendor with a poor MCP server gives a poor experience, and the fix is
  theirs. We document that rather than paper over it.
- Agents see vendor-specific tools (`jira__transition_issue`,
  `linear__update_issue`), so there is no `issue__move` to rely on. "Move the
  ticket to its next status" works because the agent asks the tracker which
  transitions exist; the tests require exactly that.
- The catalogue needs upkeep: endpoints and auth flows change. Entries are data
  and verified per vendor, so a stale one is removed rather than half-working.
- OAuth makes Fabrikka an OAuth client of many vendors. A pre-registered client
  is one more thing an operator configures and protects, as with Google (ADR 0021).

## Alternatives considered

**A normalized API per category** (`issues.list / create / transition`, with one
adapter per vendor). It gives a uniform tool surface and lets Fabrikka build
UI on tickets. Rejected:
- it's lossy (a Jira epic, a Linear project and a ClickUp list aren't the same
  thing, and the adapter has to pick a lie);
- it's an adapter per vendor maintained forever, in a codebase whose bet is
  writing zero plugins;
- it puts Fabrikka between the team and its tracker, the role ADR 0002 refuses
  for agent runtimes.

**Keep M8 as it is** (URL and token). That's no new work. Rejected: it fails the
stories outright, because the vendors that matter most use OAuth.

**Integrations hosted by a third party** (an MCP gateway or integration-platform
service). It gives breadth for free. Rejected: every call and token would pass
through a company that isn't the team or the vendor, which is what self-hosting
operators run an instance to avoid.

**Team-level shared credentials**, connected once for everyone. This is the
convenience people will ask for. Rejected here, for the reasons of ADR 0004:
every call would be attributed to one person, and inviting someone would lend
them that person's access. A future team agent (roadmap, *Later*) that needs its
own credentials is a separate decision.
