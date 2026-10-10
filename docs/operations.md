# Operations

Running a Fabrikka instance. **No outbound email is required** — see
[ADR 0007](decisions/0007-email-is-a-transport.md).

## Self-hosting with Docker (M39)

On any server with Docker, and a domain whose DNS points at it:

```bash
git clone <this repository> fabrikka && cd fabrikka/docker/selfhost
./init.sh fabrikka.example.com   # once: writes .env, every secret generated
docker compose up -d              # the server, Postgres 17, and Caddy for HTTPS
docker compose logs server        # the setup code
```

Open `https://fabrikka.example.com`. It lands on **Set up Fabrikka**: enter
the setup code, your name, email and a password, then **Create owner**
([ADR 0035](decisions/0035-the-first-owner-is-created-in-the-browser-with-a-setup-code.md)).
After that, `/setup` is gone, and everyone else joins by invite.

- **Migrations run when the server starts.** There's no step for them.
- **What to back up:**
  - the `pgdata` volume, or a `pg_dump`;
  - the `data` volume (uploads, and `encryption.key` if you didn't set one);
  - `.env`.
- **Upgrading:** `git pull && docker compose up -d --build`. A published image
  comes later.
- **Ports:** Caddy takes 80 and 443. `HTTP_PORT` and `HTTPS_PORT` in `.env` move
  them, and then `PUBLIC_URL` has to include the port.
- **The image alone** (`docker build -f docker/Dockerfile -t fabrikka .`) runs
  anywhere with Postgres:
  - It needs `DATABASE_URL` and `PUBLIC_URL`, and keeps everything else in
    `/data`.
  - `FABRIKKA_ENCRYPTION_KEY` and `FABRIKKA_SETUP_CODE` are optional. Without
    them, the image generates a key into `/data` and prints a setup code in its
    log.

## First run from a checkout

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm dev        # migrations run when the server starts
```

The first owner is created in the browser: open the app, and it sends you to
**Set up Fabrikka**, with the setup code printed in the server's output. Or,
from the CLI (the only way before M39, and it still works):

```bash
pnpm admin create-user --email you@example.com --owner
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
| `admin funnel [--since <date>]` | *(M17)* Aggregate invite-loop counts: invites created and redeemed, redeemed by a new account, redeemers who connected an agent within 7 days, and redeemers who went on to create a session or send an invite. Counts only, no emails or names, read from this instance's own tables. Nothing is sent anywhere. |

The CLI and the HTTP API are thin wrappers over the same functions, so they
cannot drift apart in behaviour.

## Registration and invites

There is **no open registration**. After the first account:

1. A member with `owner` role on a session creates an invite.
2. Fabrikka returns a **link**. The UI offers *Copy invite link*.
3. The operator sends that link however they like — Slack, Signal, in person.
4. The recipient opens it and either signs up or logs in, and joins that session.

**Teams** *(M21)* use the same links: a team owner creates a team invite, and
whoever redeems it joins the team, creating an account if they need one. A team
invite is the second way to get an account, and there is still no open signup.

An invite is **single-use, expiring (7 days by default) and revocable**. It may
optionally be **scoped to an email address**, in which case only a user
authenticating as that address can redeem it — enforced at redemption, so it
needs no mail configuration.

> An invite link is a bearer credential in a URL. Treat it like a password:
> anyone who reads it can join that session until it is redeemed, expires or is
> revoked. See `docs/security.md`.

## Email (optional, cloud)

Email is a transport for links the system already generates, never a
prerequisite. With no transport configured every feature still works: invites
are copied by hand and password resets go through the CLI.

Configuring one adds email-shaped affordances on top of the same flows. It is not
a different code path and there is no deployment-mode flag. Since M32
([ADR 0029](decisions/0029-the-core-is-a-library-a-deployment-extends-it.md)):

| `FABRIKKA_MAIL` | Effect |
| --- | --- |
| unset or `none` | No email. The default. |
| `log` | Each message is printed to the server log. For a quick local try. |
| `file:<dir>` | Each message is written to `<dir>` as one JSON file. For development and the acceptance checks. |

With a transport configured, the login page offers **Forgot password?**: a
single-use link, valid for one hour, that signs the account out everywhere once
used. A transport for a real email provider comes later.
*Send invite by email* is not built yet.

## Deployments that extend the core

The server is also a library (M32). A deployment can be a small program that
calls `createApp({ extensions })` from `@fabrikka/server`, adds its own routes,
tables and pages, and starts it. A sign-up page for a hosted instance is built
that way. The kit an extension may use is listed in
`docs/protocol.md`. Everything else in the core is internal.

## The license, and your source

Fabrikka is licensed **AGPL-3.0-only** ([ADR 0034](decisions/0034-license-agpl-3.0.md)).

- **Running it unmodified,** for yourself, your team or your company, asks
  nothing of you.
- **Running a modified version for other people over a network** (changed code,
  or an extension built on `createApp`) means offering those people your
  source, under the AGPL.
  - Build the web app with `VITE_SOURCE_URL=<your repository>`.
  - The sidebar's *Source code · AGPL-3.0* link then points at your source, not
    upstream's.
- **What people make in a room** (messages, outputs, files) and **the agents
  that connect over MCP** are not covered by the AGPL. They're yours.

## Connecting a computer (the local client)

Every instance serves its own client and installer (M33, [ADR 0030](decisions/0030-every-instance-serves-its-own-client-installer.md)). The
command, shown with a **Copy** button under *Your devices*, is:

```bash
curl -fsSL https://<your instance>/install.sh | bash
```

It needs **Node 22 or newer** on the machine, and installs only Fabrikka's own
client, into `~/.local/share/fabrikka/` with a `fabrikka` launcher in
`~/.local/bin` (no `sudo`). It then starts `fabrikka host` already pointed at
this instance, which opens the pairing page. Options, passed as
`… | bash -s -- --no-connect`:

| Option | Effect |
| --- | --- |
| `--no-connect` | Install only; run `fabrikka host` later. |
| `--no-modify-path` | Don't add `~/.local/bin` to `~/.zshrc` / `~/.bashrc`. |

The instance serves the client it was built with (`pnpm build` builds it), so a
new server release carries its own client. Connected hosts show "update
available", and `fabrikka update` installs it. If the instance has no client
build, the three routes answer 404 and *Your devices* shows no command.

The server's generated agent commands use `BRIDGE_COMMAND`, which defaults to
`fabrikka`, the installed client. Point it at a local build when developing
the bridge itself: `BRIDGE_COMMAND="node /abs/path/packages/bridge/dist/cli.js"`.

## Running agents unattended

`fabrikka watch --dir <project>` spawns a headless agent run for each mention it
is given. **Runs start without permission prompts** — a headless agent cannot stop
to ask. Starting the process is the consent: you chose the directory, and it prints
what it will do before doing anything. See
[ADR 0011](decisions/0011-spawning-is-local-and-opt-in.md).

The session UI generates the command under *Agents → While away*.

| | Claude Code | Codex |
| --- | --- | --- |
| Spawn | `claude -p …` with the policy's flags | `codex exec … --approve-for-me` |
| Policy | **`edit` by default**: files in the folder only, no shell, no web. `--policy read` or `--policy full` (no sandbox) | `read`, `edit` or `full` (M35). Writes and network confined, **reads are not**; see ADR 0032 |
| Sandbox | enforced by Claude Code's own tool restrictions; none under `full` | workspace-write |
| Session tools during the run | yes, via `--mcp-config` | yes, via `-c mcp_servers.…` overrides |
| How the answer gets posted | the agent calls `post_message` itself | the same |

Since M31, Claude Code's default is the more contained of the two: *Edit in
folder* can't run commands at all. Codex's workspace-write sandbox can run
commands, inside the folder. Claude Code's `full` policy has no sandbox, so grant
it only where an agent truly needs to run things, such as tests. See
[ADR 0027](decisions/0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md).

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

**Team credentials (M30).** A team owner can add a connection that belongs to the
team, under *Team integrations*. Members, and their agents, use it in that team's
sessions wherever they haven't attached their own. Every call made with it is
recorded with the participant who made it, the tool and the outcome (never the
arguments), and team owners see recent uses on the same page. See
[ADR 0028](decisions/0028-team-credentials-are-shared-marked-and-lose-to-your-own.md).
The record has no retention limit yet; it is one small row per call.

### Connections by vendor (M18)

Listed vendors connect with a click: *Personal integrations → Add a connection*.
Most need no setup on the instance, because their MCP servers let Fabrikka
register itself (Atlassian, Grafana Cloud). **GitHub doesn't**, so it appears
only once the instance has a GitHub OAuth App:

1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**.
2. Homepage URL: your `PUBLIC_URL`. Authorization callback URL:
   `<PUBLIC_URL>/api/connections/oauth/callback`.
3. Register, then **Generate a new client secret**.
4. In `.env`: `GITHUB_OAUTH_CLIENT_ID=…` and `GITHUB_OAUTH_CLIENT_SECRET=…`.
   Restart the server.

A GitHub OAuth App has one callback URL, so each instance, hosted or
self-hosted, registers its own.

**Adding a vendor** is one file in `apps/server/src/connections/catalogue/` and
one registry line. Besides its endpoint and sign-in, the file carries
`keywords` for the search box and a `logo`: the vendor's single SVG path and
brand colour, copied from Simple Icons (CC0) at a pinned version. The server
refuses a logo that is anything but path data and a hex colour.

### Custom connections that sign in with an email and an API token

Some vendors take a personal API token only as HTTP Basic, with your email as the
username. *Custom connection → Sign in with: Email + API token* sends
`Authorization: Basic base64(email:token)` on every call, built from what you
typed and stored sealed, like any credential.

**Atlassian (Jira, Confluence) with a personal API token:**
1. An org admin switches API tokens on: Atlassian Administration → **Rovo** →
   **Rovo MCP server** → *Authentication* → **API token**. It's off by default.
2. Create a token at id.atlassian.com → Security → API tokens.
3. Custom connection: URL `https://mcp.atlassian.com/v2/mcp`, **Email + API
   token**, your Atlassian email and the token.

Some Atlassian tools aren't available with token sign-in, and the tools must be
told which site (`cloudId`) to use. The catalogue's Jira and Confluence
entries, which sign in with OAuth, need neither the admin switch nor a token.

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

A Tauri app around the same web app that, since M34, also **runs your agents**:
it carries its own Node and the instance's client, and runs the local host for
you, with a tray icon and a **Folders** window ([ADR 0031](decisions/0031-the-desktop-app-runs-the-local-host.md)).

```bash
pnpm --filter @fabrikka/desktop node:fetch   # once: the pinned official Node build, checksum-verified
pnpm --filter @fabrikka/desktop package      # builds the app and the zip the instance serves
```

Install it on a Mac from the instance: `curl -fsSL https://<instance>/install.sh
| bash -s -- --app`. If the tray says "the bundled client is missing: unknown
path", the app was started from a path that runs through a symlink (as macOS's
`/var` does): Tauri won't trust its own location there. Install into
`~/Applications`, which the installer does. It's unsigned until launch: a copy downloaded with a browser
needs System Settings → Privacy & Security → **Open Anyway**. The installer
route needs nothing like that, because `curl` doesn't mark files as downloaded.


```bash
pnpm --filter @fabrikka/web build     # the server serves this
pnpm --filter @fabrikka/desktop build
```

**Links to other sites open in your default browser,** in a new tab, as they
would from any desktop app. Pages of your own instance stay in the app window.
Connecting an integration happens there too: its sign-in opens in the browser, asks
you to confirm which Fabrikka account it connects, and Personal integrations
picks the connection up when you switch back to the app
([ADR 0033](decisions/0033-desktop-sign-ins-finish-in-the-default-browser.md)).
See [security.md](security.md#the-desktop-app-m34).

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
