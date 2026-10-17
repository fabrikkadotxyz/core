# 0056 — Apps for every desktop: built per platform in CI, served per instance

**Status:** Proposed
**Date:** 2026-10-17
**Builds on:** [ADR 0030](0030-every-instance-serves-its-own-client-installer.md)
(every instance serves its own client and installer), [ADR 0031](0031-the-desktop-app-runs-the-local-host.md)
(the desktop app runs the local host; signing waits for launch), M33 and M34.

## Context

Since M34 an instance serves one desktop app, for macOS on Apple Silicon, and
one installer, `install.sh`, which installs the command-line client anywhere
Node runs and the app with `--app` on that one platform. The packaging script
refuses any other machine, the bundled Node is pinned for that one target, and
Tauri does not cross-compile. People on Windows and Linux, and on Intel Macs,
have no app and, on Windows, no installer at all.

The owner asked for installs on Windows, Linux and macOS that work like the
line under *Your devices* (2026-10-17), and decided: build in GitHub Actions,
sign Windows later, include Intel Macs.

## Decision

**1. Four platforms, one app each, built on their own runners in GitHub
Actions.** macOS arm64 and x64 as a zipped `.app`, Linux x64 as an AppImage,
Windows x64 as an NSIS installer (per user, no admin, silent with `/S`; not
MSI, which wants an administrator for a machine-wide install). One workflow,
`.github/workflows/desktop.yml`, on a tag `app-v*` or by hand, runs the same
`package` script on each runner; the script gains per-platform knowledge: the
pinned official Node for that platform (checksum-verified, as before), Tauri's
target triple, the bundle kind, and the file name. Each job uploads its file,
its `.sha256` and a small `.meta.json`; a last job merges those into
`apps.json` and attaches everything to a GitHub release of that tag. Nothing
is signed yet (ADR 0031): macOS copies installed by the script carry no
quarantine flag, and on Windows the script strips the mark-of-the-web before
running the installer. A browser download still warns on both; signing and
notarisation are launch work.

**2. An instance serves what it installs, per platform.** The server keeps
serving from `apps/desktop/dist-app/`, now a folder of files named in
`apps.json` (`platform`, `file`, `sha256`, `size`), each at
`/downloads/<file>` with its `.sha256` beside it, and `downloads/manifest.json`
lists them under `apps`. An instance that packaged its own app serves that one
(a folder with only the old macOS zip still counts, as that platform's entry).
The hosted image takes them from a release: `docker build --build-arg
FABRIKKA_APPS_URL=https://github.com/<owner>/<repo>/releases/download/app-v1`
downloads `apps.json` and every file it names, verifying each checksum, into
the image. So ADR 0030 holds for the apps too: the files come from the
instance you connect to, and the checksum the installer checks is the one that
instance serves.

**3. Two installers, the same behaviour.**

- `install.sh` stays the line for macOS and Linux. `--app` reads `uname` and
  installs the app for that platform: the Mac zip into `~/Applications` as
  before; the AppImage into `~/.local/bin/fabrikka-app`, executable, with a
  `.desktop` entry so it shows in the launcher. It writes the server address
  into the app's settings folder for that platform, then opens the app.
- `install.ps1` is the line for Windows, served by the instance with its
  address written in: `irm <instance>/install.ps1 | iex`. It installs the
  **app** by default, because the app carries its own Node and Windows has
  no `~/.local/bin` habit; `$env:FABRIKKA_INSTALL='client'` first installs
  the command-line client instead (Node 22 or newer, into
  `%LOCALAPPDATA%\fabrikka` with a `fabrikka.cmd` shim on the user's PATH).
  `$env:FABRIKKA_NO_CONNECT='1'` installs without opening anything. The same
  rules as the shell script: https only except localhost, the checksum from
  the manifest must match or nothing is installed, nothing elevated, nothing
  but Fabrikka's own files.

**4. Your devices shows the line for the computer you are on.** The page
reads the browser's platform and shows that command with Copy, and a switch
for the others. Still one paste, once per machine: the five-click rule's
one-time setup, unchanged.

**5. The app runs where it is built.** The few macOS-only parts of the shell
get their branches: the PATH the host searches uses the platform's separator
and, on Windows, the folders where npm puts commands; the login-shell lookup
is skipped where there is no login shell. The host and the client are Node and
already know `win32`. **Caveat:** until the owner's first run on each, Windows
and Linux hosts are built, not tested; the roadmap's manual test is that run.

## Consequences

- Release = push a tag. Four runners, about ten minutes, one GitHub release.
  Actions is free on a public repository; private, it has a monthly budget
  with macOS at ten times and Windows at twice the rate.
- The Docker image grows by the four apps (some 100 MB) only when
  `FABRIKKA_APPS_URL` is given. Without it, an instance serves the client and
  no app, as today without a packaged one.
- The server never builds anything: it serves files it was given.
- Intel Macs cost one more runner, nothing else.

## Alternatives considered

**One MSI for Windows.** Machine-wide, administrator prompt, and no quiet
per-user path. NSIS does per-user installs silently and is what Tauri ships.

**Downloads from GitHub directly.** Cuts the instance out of the path: the
checksum you verify would come from somewhere other than the server you
trust, and a self-hosted instance with no internet could serve nothing. The
instance serves; the image fetches once at build.

**Cross-compiling on one runner.** Tauri's bundlers and webviews are native
per platform; the official route is one runner per target.

**A single `install.sh` that handles Windows through WSL or Git Bash.** Most
Windows machines have PowerShell and nothing else; the one-liner people know
there is `irm … | iex`.
