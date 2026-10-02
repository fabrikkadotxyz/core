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
| [0004](0004-per-participant-credentials.md) | MCP credentials are per-participant | Accepted |
| [0005](0005-two-sdk-generations.md) | Two MCP SDK generations in one repo | Accepted |
| [0006](0006-owner-scoped-endpoint-path.md) | Owner-scoped MCP endpoint path | Accepted |
| [0007](0007-email-is-a-transport.md) | Email is a transport, not a mechanism | Accepted |
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
