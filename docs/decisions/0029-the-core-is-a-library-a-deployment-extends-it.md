# 0029 — The core is a library; a deployment extends it

**Status:** Accepted
**Date:** 2026-10-07
**Amends:** [ADR 0007](0007-email-is-a-transport.md), its *Registration policy* and
its password-reset consequence. Email stays optional; the core still has no open
registration.

## Context

Fabrikka will run two ways (ARCHITECTURE.md): in an organization's own cloud, and
as a hosted instance for anyone who doesn't want to run it. A hosted instance
needs things a self-hosted instance for one team doesn't:

- **A stranger has to be able to start.** ADR 0007 allows exactly two ways to get
  an account: the operator's CLI and an invite link. Someone signing up on a
  hosted instance has neither.
- **A person who isn't the operator can't run the CLI**, so "password reset is
  an operator action" (ADR 0007) locks them out.

A deployment, such as a hosted instance, should be able to add sign-up and other
routes of its own without forking the core. Three shapes were weighed: a package
inside the same server process, a separate accounts service beside it, and a
folder of deployment code in this repository. This ADR picks the first.

## Decision

**The core server is a library. A deployment is a small program that creates the
core's app, adds its own extensions, and starts it. A hosted instance's sign-up is
such an extension. The core knows nothing about it.**

### The core as a library

- `@fabrikka/server` exports **`createApp(options)`**, which builds the whole
  server (API, MCP endpoint, sockets and web app) and returns it unstarted, with a
  `start()` that listens. The core's own entry point is `createApp().start()`,
  so running the core alone is unchanged.
- `options.extensions` is a list of **extensions**. Each one gets the app's
  router before the web app's catch-all, and the **kit**.
- **The kit** is the supported surface, small and documented in
  `docs/protocol.md`:
  - **Accounts:** `createAccountWithOwnTeam`, `signIn`, `findUserByEmail`.
  - **Email:** `sendEmail`.
  - **Rate limiting:** `rateLimit`.
  - **Other:** `requireUser`, `publicUrl`, and the database handle.
  - **Advertising:** `advertise({ signupUrl })`, which tells the web app a
    sign-up page exists.

  Anything outside the kit is internal and can change in any release.
- One app per process. The core's in-memory hubs (sockets, the local host, the
  event bus) are process-wide.

### Registration: still closed in the core, openable only into a new team

- The core still has **no sign-up route** of its own. Accounts come from the CLI
  or an invite, as before.
- An extension can open registration through **one** kit function,
  **`createAccountWithOwnTeam`**. It creates the user **and** a brand-new team
  that they own, in one transaction. The kit has no function that creates an
  account inside an existing team or session.

  So an account made this way **reaches nobody else's data**. The only way
  further in is an invite, exactly as today. The property ADR 0007 protected
  holds: being able to register grants nothing.
- In-process code is trusted code. An extension holds the database handle and
  could bypass the kit. The kit is a contract between the core and the
  deployment, not a sandbox. A deployment's own design binds it to the kit.

### Email: a transport the core can use, never one it needs

ADR 0007 already promised email as an optional transport, with *email-shaped
affordances appearing when a notifier is configured*. This ADR builds it:

- **`FABRIKKA_MAIL`** selects a transport: unset or `none` (the default; no
  email at all), `log` (printed to the server log), or `file:<dir>` (one JSON
  file per message, for development and tests). A real provider is a later
  transport behind the same interface. There is still no deployment-mode flag:
  a configured transport is a capability, and absent configuration everything
  works as before.
- **Password reset by email**, in the core, for self-hosters too:
  - **Offered only when a transport is configured.** The login page shows
    *Forgot password?* only then. Without one, recovery is the operator's
    `reset-password`, as before.
  - **The link is a single-use token,** hashed at rest and valid for one hour.
    Using it logs the account out everywhere, like the CLI reset.
  - **The request answers the same whether or not the email has an account,**
    so it can't be used to find out who's registered.
  - **Requests are rate-limited** per email and per IP.
- **Email verification** is the deployment's concern, as ADR 0007 said. A
  deployment's sign-up verifies before it creates anything, and records
  `users.email_verified_at`, the column ADR 0007 reserved for this.

## Consequences

- The core gains a real public API, the kit, and has to keep it stable for
  every deployment built on it. Kept small on purpose.
- A deployment is one more program, not a fork: it pins a core version and
  adds its routes, its tables (in its own Postgres schema, with its own
  migrations) and its pages.
- Self-hosters get password reset by email for free once they configure a
  transport, which is the "email-shaped affordance" ADR 0007 deferred.
- The 2,155-line server module turns into a function. That's mechanical, and
  every acceptance check has to pass unchanged.
- A sign-up rate limiter that lives in memory is per process. That's fine for one
  process. A second process needs it in Postgres, like the turn budget.

## Alternatives considered

**A separate accounts service** that creates users through a provisioning API.
That would be total separation and any tech stack. Rejected for now: it needs two
services, a cross-domain sign-in hand-off that is security-critical code of its
own, and "account created, team creation failed" becomes a distributed problem.
`createAccountWithOwnTeam` is one transaction in-process. The kit could later be
exposed over HTTP without changing the rule.

**A folder of deployment code in this repository.** It's the fastest. Rejected:
code that only one deployment needs would ship to every self-hoster, and the
boundary between the core and a deployment would be a convention, not an API.

**A deployment-mode flag** (`FABRIKKA_MODE=cloud`) that turns sign-up on.
Rejected for ADR 0007's own reasons: it puts a deployment's branch inside the
core. An extension that isn't loaded can't run.

**Open registration in the core**, behind a setting. Rejected: every self-hosted
instance would carry an anonymous write surface it never asked for, and one
deployment's sign-up policy (verification, bot protection) would be written into
every instance.
