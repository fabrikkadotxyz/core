# 0046 — Google products are separate connections

**Status:** Proposed
**Date:** 2026-10-15
**Builds on:** [ADR 0024](0024-connections-are-categories-over-vendor-mcp-servers.md)
(a connection is the vendor's own MCP server).

## Context

Google hosts one MCP server per Workspace product: Gmail, Calendar, Drive,
Sheets, Docs. They share one authorization server (`accounts.google.com`),
one pre-registered OAuth client per instance, and Google's tokens aren't bound
to one server, so a single consent with every scope could serve all five.
Each product has its own scopes, and the scopes fall in different verification
tiers: Calendar, Drive, Docs and Sheets are *sensitive* (standard review);
Gmail is *restricted* (a security assessment, weeks). Google's servers also
answer unauthenticated requests without a challenge, and publish their
authorization-server metadata at the standard URL.

## Decision

- **One entry, one connection, per product.** Gmail, Google Calendar, Google
  Drive, Google Sheets and Google Docs are five catalogue entries with five
  slugs. Connecting one asks only that product's scopes, so the consent screen
  says what it is for, and a person can have Calendar without Gmail. The
  shared client is the same mechanism GitHub uses (`auth.client`).
- **Discovery follows the spec where the vendor gives no hint.** A server that
  answers without a `WWW-Authenticate` challenge has its protected-resource
  metadata looked up at the path-inserted well-known URL (RFC 9728 §3), then
  at the origin's; an authorization server without RFC 8414 metadata is read
  through its OpenID configuration. No Google-specific code.
- **An entry may add parameters to the authorization request**
  (`auth.authorizeParams`): Google issues a refresh token only with
  `access_type=offline` and `prompt=consent`.
- **Gmail is prepared with the rest but connected last,** once its scopes are
  on the consent screen and the restricted-scope review is under way. The
  Workspace cross-corpus server (`workspacemcp.googleapis.com`) is a sixth
  entry for that same round.

## Consequences

- Five consents for five products, each small and legible, instead of one
  broad one. That is also five rows in Personal integrations.
- Google's one-hour access tokens are refreshed by the existing refresh path.
  While the Google app is in *Testing* status, Google expires refresh tokens
  after seven days, so previews say *needs reconnecting* weekly until the app
  is verified and published.
- Two new categories, *Email* and *Calendar*, beside the four.

## Alternatives considered

- **One "Google" connection with every scope.** One click for the person, but
  one consent asking for mail, files and calendar at once, and Gmail's
  restricted tier would hold the other four hostage.
