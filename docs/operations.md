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

## Integrations (MCP aggregation)

A session can attach external MCP servers — GitHub, Sentry — and expose them to
agents as `github__list_issues`. Three rules make this safe, and all three are
enforced, not advisory:

1. **Credentials are per-participant.** Each member attaches their own; a call
   goes upstream with the *caller's* token, so external audit logs attribute
   actions to the right person ([ADR 0004](decisions/0004-per-participant-credentials.md)).
2. **Tools are default-deny.** Attaching an integration grants nothing until the
   session owner permits specific tools. "GitHub read but not merge" is the actual
   requirement, so grants are per tool, not per server.
3. **HTTP servers only.** A command-launched stdio server would make this process
   an arbitrary-command executor driven by database rows; local servers belong to
   the bridge ([ADR 0014](decisions/0014-aggregation-is-http-only-and-credentials-are-encrypted.md)).

### The encryption key

Credentials are sealed with AES-256-GCM under `FABRIKKA_ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

**Without it, attaching a credentialed integration is refused** — the feature is
unavailable rather than storing tokens in plaintext.

Losing the key makes stored credentials unrecoverable. That is the intended
failure: re-attaching takes a minute, and a key that can be lost without
consequence was not protecting anything. Back it up with the same care as the
database, and separately from it.

A credential is never returned by any API and never logged; the UI shows only
whether one is set.

## Artifacts

Uploaded files are stored on local disk — a self-hoster should not have to
configure object storage to attach a CSV. The location is `ARTIFACT_DIR`,
defaulting to `.artifacts/` in the repo root.

Files are named by the **SHA-256 of their content**, sharded two levels deep. Two
people uploading `notes.md` therefore share one blob and neither overwrites the
other ([ADR 0013](decisions/0013-context-is-append-only-with-explicit-removal.md)).

Limits: 10 MB per file. Deleting an artifact removes the row but **leaves the
blob**, because another artifact may reference the same content; at MVP scale we
do not collect that garbage, and say so rather than letting you discover it.

Back up `ARTIFACT_DIR` alongside the database — the rows are useless without it.

## Outputs

Native outputs (`doc`, `latex`) are stored in the database as encoded Yjs state —
the regular database backup covers them; there is nothing on disk.

**LaTeX** compiles in each viewer's browser (ADR 0020); the instance only serves
the engine and the TeX Live tree, so no third party learns which packages a
document uses. Install them once:

```bash
pnpm tex:install          # ~360 MB into .tex-assets/ (TEX_ASSETS_DIR to override)
```

They are served at `/tex-assets/`, uncompressed and cacheable forever (they are
versioned by directory). Without them the `latex` kind is absent from **Add output**
and from `create_output` — nothing is broken, it is just not offered. Back them up
or not: they are reproducible from the pinned release.

**Google Docs** *(M14, not built)* needs an OAuth client the operator registers in their own Google
Cloud project:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# redirect URI to register: https://<your-host>/api/google/callback
```

Request only the `drive.file` scope. Without these variables the `gdoc` kind is
simply absent from **Add output**. Connecting a Google account also requires
`FABRIKKA_ENCRYPTION_KEY` (above) — refresh tokens are sealed with it, and
connecting is refused without it. Keep the client secret with the same care as the
key.

## Desktop app

A thin Tauri shell around the same web app. It adds no product surface — the
things desktop uniquely enables (local MCP servers, local files, local-only
sessions) are Phase II.

```bash
pnpm --filter @fabrikka/web build     # the server serves this
pnpm --filter @fabrikka/desktop build
```

The bundle lands in `apps/desktop/src-tauri/target/release/bundle/`. On first run
it asks for the server URL and remembers it; `FABRIKKA_URL` overrides, so a
managed deployment can pin it.

**Serving the UI is the server's job in production.** `pnpm dev` uses Vite on
:5173, but a deployed instance (and the desktop app) needs one origin for the UI,
the API, the MCP endpoint and the bridge. The server serves `apps/web/dist` when
it exists, with an SPA fallback so deep links survive a refresh.

Windows and Linux targets are configured but must be built on their own
platforms; there is no cross-compilation here, and nothing is code-signed yet.

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
