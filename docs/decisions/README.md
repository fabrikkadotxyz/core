# Architecture Decision Records

One file per architectural decision. Numbered, immutable once accepted.

## Rules

- **Write the ADR before implementing.** This project is documentation-first (see `CLAUDE.md`); an ADR is the doc that comes first for an architectural choice.
- **Accepted ADRs are not edited.** If a decision changes, write a new ADR that supersedes the old one and mark the old one `Superseded by NNNN`. The record of what we believed and why is the point.
- **Record the rejected options.** An ADR that lists only the choice made is a changelog entry, not a decision record.

## Format

```markdown
# NNNN — Title

**Status:** Proposed | Accepted | Superseded by NNNN
**Date:** YYYY-MM-DD

## Context
What forced a decision. Include evidence — versions, spec revisions, measurements.

## Decision
What we chose.

## Consequences
What this costs, what it forecloses, what now has to be true.

## Alternatives considered
What we rejected and why.
```

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-session-is-an-mcp.md) | The session is itself an MCP | Accepted |
| [0002](0002-do-not-own-the-agent-runtime.md) | Fabrikka does not own the agent runtime | Accepted |
| [0003](0003-hybrid-wake-up.md) | Hybrid wake-up: channels when live, spawn when away | Accepted |
| [0004](0004-per-participant-credentials.md) | MCP credentials are per-participant | Accepted; superseded for team credentials by 0028 |
| [0005](0005-two-sdk-generations.md) | Two MCP SDK generations in one repo | Accepted |
| [0006](0006-owner-scoped-endpoint-path.md) | Owner-scoped MCP endpoint path | Accepted |
| [0007](0007-email-is-a-transport.md) | Email is a transport, not a mechanism | Accepted; amended by 0029 |
| [0008](0008-mentions-as-stable-markers.md) | Mentions are stable markers, and mention rows are derived | Accepted |
| [0009](0009-participant-scoped-tokens.md) | Session tokens are participant-scoped, and OAuth is deferred | Accepted |
| [0010](0010-bridge-proxies-and-gates-at-source.md) | The bridge proxies upstream, and delivery is gated at the source | Accepted |
| [0011](0011-spawning-is-local-and-opt-in.md) | Spawning happens on the user's machine, and running the runner is the consent | Accepted |
| [0012](0012-halt-is-server-side-termination-is-cooperative.md) | Halting is server-side; terminating a run is cooperative | Accepted |
| [0013](0013-context-is-append-only-with-explicit-removal.md) | Session context is append-first, and artifacts are content-addressed | Accepted |
| [0014](0014-aggregation-is-http-only-and-credentials-are-encrypted.md) | Aggregated servers are HTTP-only, and credentials are encrypted or refused | Accepted |
| [0015](0015-activity-is-a-redacted-summary.md) | Activity is a redacted summary, not a transcript | Accepted |
| [0016](0016-steering-is-stop-and-resume.md) | Steering is stop-and-resume, not interruption | Proposed |
| [0017](0017-model-selection-is-spawn-only.md) | Model selection is spawn-only, opaque, and reported | Proposed |
| [0018](0018-session-screen-is-three-panes.md) | The session screen is three panes: configure, converse, produce | Accepted |
| [0019](0019-outputs-are-live-documents-behind-adapters.md) | Outputs are live documents behind one adapter contract | Accepted |
| [0020](0020-latex-compiles-in-the-browser.md) | LaTeX compiles in the browser, never on the server | Accepted |
| [0021](0021-google-docs-writes-use-the-editors-own-account.md) | Google Docs writes go through the editor's own Google account | Proposed |
| [0022](0022-nothing-leaves-a-session-without-a-members-deliberate-act.md) | Nothing leaves a session without a member's deliberate act | Proposed |
| [0023](0023-an-output-kind-is-a-plug-in-module.md) | An output kind is a plug-in module | Accepted |
| [0024](0024-connections-are-categories-over-vendor-mcp-servers.md) | Connections are categories over vendors' own MCP servers | Proposed |
| [0025](0025-teams-and-who-can-see-a-session.md) | Teams, and who can see a session | Accepted |
| [0026](0026-chats-are-a-light-kind-of-session.md) | Chats are a light kind of session | Accepted |
| [0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md) | A paired local host runs agents in folders granted on the machine | Accepted |
| [0028](0028-team-credentials-are-shared-marked-and-lose-to-your-own.md) | Team credentials: shared, marked as shared, and second to your own | Accepted |
| [0029](0029-the-core-is-a-library-a-deployment-extends-it.md) | The core is a library; a deployment extends it | Accepted |
| [0030](0030-every-instance-serves-its-own-client-installer.md) | Every instance serves its own client, with a one-line installer | Accepted |
| [0031](0031-the-desktop-app-runs-the-local-host.md) | The desktop app runs the local host; signing waits for launch | Proposed |
| [0032](0032-codex-on-the-host-confines-writes-not-reads.md) | Codex on the local host confines writes, not reads, and says so | Proposed |
| [0033](0033-desktop-sign-ins-finish-in-the-default-browser.md) | In the desktop app, a vendor sign-in runs in the default browser, through a one-time handoff | Proposed |
| [0034](0034-license-agpl-3.0.md) | License: AGPL-3.0, with a contributor agreement | Accepted |
| [0035](0035-the-first-owner-is-created-in-the-browser-with-a-setup-code.md) | The first owner is created in the browser, with a setup code | Proposed |
| [0036](0036-chat-apps-connect-through-oauth-to-a-per-person-endpoint.md) | Chat apps connect through OAuth to a per-person endpoint | Proposed |
| [0037](0037-needs-you-is-derived-and-reaches-you-where-you-are.md) | "Needs you" is derived from the record, and reaches you where you are | Proposed |
| [0038](0038-themes-are-css-packs-checked-by-the-server.md) | Themes are CSS packs: tokens are the contract, the server checks them | Proposed |
| [0040](0040-email-goes-out-over-smtp.md) | Email goes out over SMTP, to any provider | Proposed |
| [0041](0041-a-deployment-can-gate-accounts-and-team-writes.md) | A deployment can gate new accounts and a team's writes | Proposed |
| [0042](0042-people-see-organization-the-code-says-team.md) | People see "organization"; the code still says "team" | Proposed |
| [0043](0043-folders-and-personal-connections-belong-to-one-organization.md) | A folder, and a personal connection, belongs to one organization | Proposed |
| [0044](0044-a-reload-paints-from-what-the-tab-last-showed.md) | A reload paints from what the tab last showed | Proposed |
| [0045](0045-a-rooms-output-opens-in-its-own-window.md) | A room's output opens in its own window | Proposed |
| [0046](0046-google-products-are-separate-connections.md) | Google products are separate connections | Proposed |
| [0047](0047-opencode-on-the-host-is-confined-by-a-per-run-config.md) | OpenCode on the local host is confined by a per-run config, reads included | Proposed |
| [0048](0048-the-workspace-is-an-icon-rail-of-four-places.md) | The workspace is an icon rail of four places | Proposed |
| [0049](0049-grants-are-set-in-a-dialog-and-a-connection-remembers-your-default.md) | Grants are set in a dialog, and a connection remembers your default | Proposed |
