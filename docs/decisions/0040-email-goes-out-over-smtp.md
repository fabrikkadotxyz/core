# 0040 — Email goes out over SMTP, to any provider

**Status:** Proposed
**Date:** 2026-10-12
**Builds on:** [ADR 0007](0007-email-is-a-transport.md) (email is a transport,
never a prerequisite) and [ADR 0029](0029-the-core-is-a-library-a-deployment-extends-it.md)
(a deployment's sign-up sends through the core's mailer).

## Context

The core's mailer has three transports: none, `log` and `file:`. None of them
reaches an inbox. A deployment with open sign-up can't verify a stranger's
address without a real one, and self-hosters can't offer "Forgot password?" by
email, so a forgotten password means a command on the server.

Every email provider offers SMTP: Resend, Postmark, Amazon SES, Brevo, Mailgun,
SendGrid, Gmail and Microsoft 365, and any company's own mail server. Each also
has its own HTTP API, which would mean code per provider.

## Decision

**One more transport: SMTP, configured as a URL. The core speaks SMTP and nothing
provider-specific, so an operator chooses any provider by changing a variable.**

- `FABRIKKA_MAIL=smtps://user:password@host:465` (TLS from the start), or
  `smtp://user:password@host:587` (STARTTLS, **required**: the server refuses
  to send credentials or mail over plain text).
- **Plain SMTP is allowed only to this machine** (`localhost`, `127.0.0.1`,
  `::1`), for local mail catchers and the acceptance check.
- `FABRIKKA_MAIL_FROM` is required with SMTP: the sender, such as
  `Fabrikka <hello@fabrikka.xyz>`. Its domain is the one the provider verified.
- **A wrong URL stops the server at start,** as a typo in `FABRIKKA_MAIL` already
  does: an instance that meant to offer email must not quietly not.
- **A provider that's down doesn't stop the server.** The connection is checked
  at start and a failure is logged. A send that fails resolves false, never
  throws, as today.
- Built on Nodemailer (MIT, no dependencies of its own), not a hand-written
  SMTP client: authentication, STARTTLS and encoding are easy to get subtly
  wrong.

## Consequences

- **Self-hosters get email password reset** by pointing at the SMTP server they
  already have. No new code path: the existing transport switch.
- **A hosted instance picks a provider by configuration,** not by a core change.
  Choosing it is an account and a verified sending domain, the operator's.
- The SMTP password sits in an environment variable, like the database URL.
  `docs/security.md` says so, and the server never logs the URL.

## Alternatives considered

- **One provider's HTTP API** (Resend, Postmark). Simple, but it ties the core,
  which is meant to be self-hosted, to one company.
- **A plug-in transport per provider.** Code to maintain for something SMTP
  already standardises.
