# 0035 — The first owner is created in the browser, with a setup code

**Status:** Proposed
**Date:** 2026-10-10
**Builds on:** M1 (auth, no open registration), M39 (one image, one compose
file) and the five-click rule (`CLAUDE.md`).

## Context

A fresh instance has no accounts, and there is no open registration. Today the
only way in is the admin CLI, run on the server:
`pnpm admin create-user --email … --owner`.

That's fine from a checkout. It fails for anyone who deployed with a button
(M40), whose server has no terminal they'd want to open, and for self-hosters
who run a container they never exec into. The five-click rule allows one-time
setup to take longer, but not to require a shell.

The danger is the window between "the instance is up" and "its owner exists". A
public URL with no owner and a form that creates one is an open door. Anyone who
finds it first owns the instance.

## Decision

**While an instance has no users, it serves a setup page that creates the
instance owner. The page only accepts the instance's setup code, and it
disappears for good once any user exists.**

- **Where the code comes from:**
  - `FABRIKKA_SETUP_CODE`, when the deployment sets it. A deploy platform
    generates it and shows it in the service's settings, as Render's
    `generateValue` does.
  - Otherwise the server generates one at start, while there are no users, and
    **prints it in its log**, the place only the person who runs the server can
    read.
  - A generated code is 20 characters of Crockford base32 (100 bits), shown in
    groups of five, and it changes on every start until the owner exists.
- **The page:** `/setup` asks for the code, an email, a display name and a
  password, then signs the new owner in. That's one form, so one click after
  typing, and it's one-time setup.
- **The checks:**
  - The code is compared in constant time.
  - Failed attempts are limited: after 10, setup refuses for 15 minutes, logged.
  - **Creating the owner and checking that no user exists happen in one
    transaction**, so two requests racing with the right code can't create two
    owners.
- **Once any user exists,** the setup routes answer 404, whether that user came
  from setup, the CLI or a seed. The CLI keeps working as before.
- **The home page sends a visitor to `/setup`** while there's no user, so the
  person who just deployed lands there without being told a path.

## Consequences

- An instance is safe to expose before setup: without the code, the page creates
  nothing. The only thing it reveals is that an instance exists and isn't set up
  yet, which a fresh instance can't hide anyway.
- The deploy docs (M40) say where the code is: the platform's environment
  settings, or the server log.
- **A lost code costs nothing:** restart the server for a new one, or use the
  CLI.

## Alternatives considered

- **The first person to sign up becomes the owner.** Common, and an open door
  for as long as the deployer takes to open the URL.
- **An owner email set at deploy time, then a magic link.** Needs outbound
  email, which a self-hosted instance doesn't have by default (ADR 0007).
- **Keep the CLI only.** Fails the people M40 is for.
