# Operations

Running a Fabrikka instance. **No outbound email is required** — see
[ADR 0007](decisions/0007-email-is-a-transport.md).

## First run

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate

# Create the first account. There is no open registration, so this is the
# only way in on a fresh instance.
pnpm admin create-user --email you@example.com --owner

pnpm dev
```

`create-user` prompts for a password on a TTY. To script it, pipe the password
on stdin — it is read from stdin rather than taken as an argument so it never
lands in shell history or `ps` output:

```bash
printf '%s' "$PASSWORD" | pnpm admin create-user --email you@example.com --owner --password-stdin
```

## Admin CLI

Everything that needs no mail server is an operator action. Run from the repo
root; in Docker, `docker compose exec server pnpm admin <command>`.

| Command | What it does |
| --- | --- |
| `admin create-user --email <e> [--owner]` | Create an account. `--owner` grants instance-owner rights. |
| `admin reset-password --email <e>` | Set a new password. **This is the password recovery path** — there is no emailed reset link. |
| `admin list-users` | Emails, display names, owner flag, created date. |
| `admin delete-user --email <e>` | Remove an account and its memberships. |

The CLI and the HTTP API are thin wrappers over the same functions, so they
cannot drift apart in behaviour.

## Registration and invites

There is **no open registration**. After the first account:

1. A member with `owner` role on a session creates an invite.
2. Fabrikka returns a **link**. The UI offers *Copy invite link*.
3. The operator sends that link however they like — Slack, Signal, in person.
4. The recipient opens it and either signs up or logs in, and joins that session.

An invite is **single-use, expiring (7 days by default) and revocable**. It may
optionally be **scoped to an email address**, in which case only a user
authenticating as that address can redeem it — enforced at redemption, so it
needs no mail configuration.

> An invite link is a bearer credential in a URL. Treat it like a password:
> anyone who reads it can join that session until it is redeemed, expires or is
> revoked. See `docs/security.md`.

## Email (optional, cloud)

Email is a transport for links the system already generates, never a
prerequisite. With no notifier configured the default is `none` and every
feature still works — invites are copied by hand and password resets go through
the CLI.

Configuring a notifier adds email-shaped affordances (*Send invite by email*,
emailed reset links, signup verification) on top of the same flows. It is not a
different code path and there is no deployment-mode flag.

Not implemented yet; tracked in `docs/roadmap.md` under Phase I.

## Backups

All durable state is in Postgres. Artifacts (M7) add object storage.

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  pg_dump -U fabrikka fabrikka > fabrikka-$(date +%F).sql
```

## Ports

| Port | What | Note |
| --- | --- | --- |
| 9090 | Fabrikka server (HTTP + WebSocket + MCP endpoint) | `PORT` |
| 5173 | Web dev server | Vite, dev only |
| 5433 | Postgres | Host-side, to avoid colliding with a local Postgres on 5432 |
