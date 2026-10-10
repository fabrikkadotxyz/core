# 0034 — License: AGPL-3.0, with a contributor agreement

**Status:** Accepted (2026-10-10, by the owner)
**Date:** 2026-10-10
**Builds on:** [ADR 0029](0029-the-core-is-a-library-a-deployment-extends-it.md)
(the core is a library; a deployment extends it).

## Context

Fabrikka has carried the AGPL-3.0 text since its first commit, but the choice
was never written down. People self-host it, change it and run it for others
over a network, and agents that Fabrikka doesn't control connect to it. Each of
them needs to know what the license asks of them.

## Decision

**Fabrikka is licensed AGPL-3.0-only. Contributions are accepted under a
contributor license agreement (CLA).**

- **It's open source** (OSI-approved). Anyone may use, self-host, study and
  change it.
- **Network use counts.** Anyone who runs a modified Fabrikka for other people
  over a network must offer those people its full source (AGPL section 13).
- **Agents aren't covered.** External agents talk to Fabrikka over MCP
  (`docs/protocol.md`), so they don't become AGPL. Neither does anything a
  person makes in a room: messages, outputs and files are theirs.
- **Contributions** are under the CLA described in `CONTRIBUTING.md`.

## Consequences

- `LICENSE` is the AGPL-3.0 text. The README and `package.json` files say
  `AGPL-3.0-only`. The desktop app's About window and the client installer say
  so too.
- `CONTRIBUTING.md` explains the CLA. A CLA check runs on pull requests.
- **Dependencies:** everything the server and app bundle must be compatible with
  AGPL-3.0 (MIT, BSD, Apache-2.0 and ISC all are). A license check runs over
  them.
- **The obligation applies to every hosted instance,** ours included: a hosted
  instance links to its source. The web app has a *Source* link for it.
