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

## Running agents unattended

`fabrikka watch --dir <project>` spawns a headless agent run for each mention it
is given. **Runs start without permission prompts** — a headless agent cannot stop
to ask. Starting the process is the consent: you chose the directory, and it prints
what it will do before doing anything. See
[ADR 0011](decisions/0011-spawning-is-local-and-opt-in.md).

The session UI generates the command under *Agents → While away*.

| | Claude Code | Codex |
| --- | --- | --- |
| Spawn | `claude -p … --dangerously-skip-permissions` | `codex exec … --approve-for-me` |
| Sandbox | **none** | workspace-write |
| Session tools during the run | yes, via `--mcp-config` | yes, via `-c mcp_servers.…` overrides |
| How the answer gets posted | the agent calls `post_message` itself | the same |

Codex is the safer of the two here: `--approve-for-me` auto-approves inside a
workspace-write sandbox, whereas Claude Code's headless mode has no sandbox. If
that matters for your use, prefer a Codex agent for unattended work.

The Codex desktop app bundles its CLI outside `PATH`, at
`~/.codex/plugins/.plugin-appserver/codex-cli/bin/codex`. The runner finds it
there automatically; `CODEX_BIN` overrides the choice.

Two Codex-specific details, both found by running it:

- The session is registered inside a run as **`fabrikka_session`**, not
  `fabrikka`. `-c` *merges* into your existing config, so if you have added the
  bridge to Codex by hand as `mcp_servers.fabrikka` (a stdio entry), injecting a
  `url` into it fails the whole run with *"url is not supported for stdio"* before
  the model even starts.
- **Codex runs do not resume.** `codex exec resume` rejects `--approve-for-me`, so
  a resumed run would stall on the first approval with nobody to answer. Each
  mention starts a fresh thread; the session timeline is the continuity.

If an agent posts nothing, the runner posts the final text for it. A run is never
silent, because from the browser silence is indistinguishable from a failure.

`--allowed-tools a,b,c` narrows what a spawned run may use. Unset means the
provider's own default.

## Stopping agents

Every session has a **Pause agents** control, and **any member can use it** —
waiting for the owner is the wrong failure mode when an agent is misbehaving. The
same state is reached automatically when the turn budget runs out (20 deliveries
per 10 minutes per session).

What pausing does and does not guarantee, precisely
([ADR 0012](decisions/0012-halt-is-server-side-termination-is-cooperative.md)):

| | Guarantee |
| --- | --- |
| No further work is sent | **Absolute.** The server stops delivering; no local process can override it. |
| A spawned run stops | **Best-effort.** Runners are asked to kill their child. One that is wedged or offline will not comply. |
| A live channel turn stops | **Not possible.** The model is mid-turn in the user's own terminal. Pausing stops the *next* push. |

Resuming clears the pause and starts a fresh budget window.

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
