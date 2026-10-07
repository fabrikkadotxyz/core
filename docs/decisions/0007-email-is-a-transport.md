# 0007 — Email is a transport, not a mechanism

**Status:** Accepted — registration policy and password reset amended by [0029](0029-the-core-is-a-library-a-deployment-extends-it.md)
**Date:** 2026-09-26

## Context

M1 was originally specified as "email/password auth, session CRUD, session_members, **invite by email**". Taken literally, that makes an SMTP provider a prerequisite for running Fabrikka at all — and a self-hoster who just wants a private room with their agents has to set up a mail sender, SPF, DKIM and DNS before two people can talk.

Invites are the obvious dependency. There are two less obvious ones, and one of them is worse:

| Feature | Needs outbound email | Failure mode without it |
| --- | --- | --- |
| Invite by email | yes | Can't add anyone |
| Email verification | yes | Can't complete signup |
| **Password reset** | yes | **Users are permanently locked out** |

Password reset is the trap. A self-hoster skips SMTP on day one to save an hour, and discovers the cost months later when someone forgets a password and there is no way back in.

The common workaround is a "deployment mode" flag that branches behaviour between cloud and self-hosted. That spreads conditionals through auth, invites and notification code, and guarantees the self-hosted path is the less-tested one.

## Decision

**Nothing in Fabrikka's core requires outbound email. Email is one optional transport for artifacts that are useful without it.**

Three concrete consequences:

1. **An invite is a durable record plus a token link, not a message.** Creating an invite produces a link; the UI offers "Copy invite link". How it reaches the recipient — Slack, Signal, a spoken sentence — is not Fabrikka's concern. Email delivery is a later add-on that sends a link the system already generates.

2. **Password reset is an operator action, not a mail flow.** `pnpm admin reset-password <email>` on the server. A self-hoster can always run it. It is also arguably stronger than an emailed reset link, since it cannot be intercepted.

3. **Email addresses are identifiers, not proven addresses.** Self-hosted performs no verification. Verification is a cloud concern layered on top, and the schema records it (`users.email_verified_at`) without the core depending on it.

**There is no deployment-mode flag.** Behaviour is driven by capability: if a notifier is configured, email-shaped affordances appear. Absent configuration the default notifier is `none`, and everything still works. Cloud is self-hosted with more configuration, not a different code path.

### Registration policy

The first account is created by CLI (`pnpm admin create-user --owner`). After that, **signup requires a valid invite token** — there is no open registration. This is not only a security default for an internet-reachable box; it collapses signup and invite-acceptance into one code path rather than two.

An invite may optionally be **scoped to an email address**, in which case only a user authenticating as that address can redeem it. This gives the security property of an addressed invite with **zero** mail configuration — the scope is enforced at redemption, not by delivery.

## Consequences

- Fabrikka runs with no mail configuration whatsoever. `docker compose up`, one CLI command, and you are working.
- Self-hosted is the *default* path and therefore the well-tested one. Cloud adds configuration on top of it.
- An invite link is a **bearer credential in a URL**, which is a real exposure — pasted into a public channel, it admits anyone. Mitigated by single-use redemption, short expiry, revocability, and optional email scoping. Recorded in `docs/security.md`.
- Operators need shell access to the server for password resets. For a self-hoster this is already true. For cloud, the hosted control plane provides it, and cloud will also configure a notifier so the CLI is a fallback rather than the primary path.
- A second admin surface exists (the CLI) that must be kept in step with the HTTP API. Contained by keeping both thin wrappers over the same functions.

## Alternatives considered

**Require SMTP.** Matches the original spec, one code path, standard flows users already understand. Rejected: it makes a mail provider a prerequisite for a local private room, which is the exact friction that stops people trying the project.

**Deployment-mode flag (`FABRIKKA_MODE=cloud|selfhosted`).** Explicit and easy to reason about per mode. Rejected: it multiplies branches across auth, invites and notifications, and the self-hosted branch inevitably rots because cloud is what gets exercised.

**Magic-link-only auth, no passwords.** Removes password reset entirely, which is attractive. Rejected: magic links *are* email, so it makes the mail dependency total rather than optional — the opposite of this decision.

**No auth at all for self-hosted, bind to localhost.** Zero friction. Rejected: sessions are private by default and hold credentials; "it's only on my machine" stops being true the first time someone port-forwards it, and there would be no membership model to build M6's trust tiers on.
