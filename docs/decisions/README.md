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
