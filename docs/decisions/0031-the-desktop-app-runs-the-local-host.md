# 0031 — The desktop app runs the local host; signing waits for launch

**Status:** Proposed
**Date:** 2026-10-07
**Builds on:** [ADR 0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md)
(the local host), [ADR 0030](0030-every-instance-serves-its-own-client-installer.md)
(every instance serves its own client) and M9 (the Tauri shell).

## Context

ADR 0027 said the host "ships as a mode of the bridge package, with the desktop
app (M9) giving it a tray and a window", and left packaging to a milestone. M9
stopped at a thin shell: it remembers a server address and shows the web app. So
today a person who wants their agents on their own computer:

- **installs and runs the host from a terminal** (M33's one-line installer), and
  it dies when the terminal closes;
- **grants folders by typing paths** into a page at `127.0.0.1:17621`, which has
  to defend itself against every website their browser opens: a secret cookie,
  Host and Origin checks;
- **switches between that page and the web app** to set things up.

The desktop app should be the way most people run Fabrikka on their machine.
Separately, macOS blocks downloaded apps that aren't signed and notarized by
Apple. Since macOS 15, getting past that takes a trip to System Settings and a
password, and company-managed Macs often forbid it. Signing needs an Apple
Developer account, which waits until the app is released.

## Decision

**The desktop app runs the local host itself, as a bundled child process, and
gives it a tray icon and a window that talk to it without any network port. Until
launch, builds are unsigned, and the instance's installer can put the app in
place. Signing and notarization are a launch step.**

### One host implementation, bundled with its own Node

**Why a runtime at all.** The host is about 2,400 lines of TypeScript, compiled
to the one `fabrikka.mjs` file. It isn't a web page but a background program:
- it keeps a connection to the server;
- it **starts Claude Code or Codex** with each folder's restriction flags;
- it reads their output as they work, and stops runs on request;
- it keeps the folders that never leave the machine.

A Tauri app is a Rust core plus a web view, and the web view runs only browser
JavaScript. A browser page can't start processes or read folders, and it stops
when its window closes, by design. So the host's JavaScript needs a real runtime
outside the browser, and macOS ships none.

- The app **bundles a Node runtime** and runs the **same `fabrikka.mjs`** that
  every instance serves (ADR 0030), as a Tauri sidecar. The host's security
  logic exists once: folder policies, refusals, the run log. The customer
  installs nothing first.
- The cost is size: a Node binary is roughly 100 MB uncompressed, about 40 MB in
  the download, per platform. That's acceptable for a desktop app.
- The app **supervises Fabrikka's own client** only: it starts the host at
  launch, restarts it if it crashes, and stops it on quit. The host still runs
  the user's already-installed Claude Code or Codex for each mention, as
  `fabrikka host` does today. **The app never installs, updates or supervises an
  agent runtime** (ADR 0002).

### No port: the window talks to the host over the child's stdin and stdout

- Started by the app, the host runs with **`--control stdio`**: no HTTP control
  page, no listening socket. It reads requests and writes replies and events as
  JSON lines, with the same operations the local page has today (state, grant,
  change a policy, remove, stop all).
- **Rust relays them** between the host and the app's **Folders** window, a
  page bundled inside the app. The window and the tray poll the host's state
  every few seconds; the host pushes only the pairing event.
- **A folder's path comes from Rust's own folder picker, never from a page.**
  The Folders window asks to add a folder; Rust opens the picker and hands the
  chosen path to the host. No page can name a path.
- The `127.0.0.1` page stays for the terminal host (`fabrikka host`), for people
  who don't use the app.
- **Pairing in the app:** the host emits the pairing URL as an event, and the app
  opens it in its main window, where the person is already signed in. That
  leaves one click: *Connect this computer*.

### The remote web app gets no access to the host — the line this design must hold

The main window shows the **remote** web app (the instance). If that page could
call the app's host commands, a compromised server could grant itself a folder,
which is exactly what ADR 0027 rules out.

- **The host commands are allowed only to the local Folders window,** through
  Tauri capabilities scoped to that window and the app's own bundled pages.
- **The remote main window gets exactly one command: `open_folders`.** It opens
  (or focuses) the local Folders window, and takes no argument: no path, no
  policy. So the web app's *Add folders…* button, on *Your devices* and in a
  session's Setup, brings up the app's own window, where the person chooses.
  The worst a compromised server can do with it is open a window.
- That one permission is granted **at runtime, for the configured instance's
  origin only** (`<scheme>://<host>[:port]/*`). It's never granted to any other
  site the window might navigate to, and no capability file names a remote
  URL.
- Choosing a folder happens in the **native folder picker**, opened from the
  Folders window. That's the user's own click on their own machine, as ADR 0027
  requires.

### What the person sees

- **A tray icon:** connected or not, and whether an agent is running. It offers
  **Open Fabrikka**, **Folders…**, **Stop all runs**, **Start at login**
  (asked on first run; on by default) and **Quit**.
- **Folders… → Add folder → (the system folder picker) → Choose:** 3 clicks,
  with no path to type or paste. The policy (*Edit in folder*, *Read only*,
  *Full*, with its warning) is chosen there, as on today's page.
- **One host per machine.** The host takes a lock file in `~/.fabrikka`. A
  second one (the terminal host while the app runs, or the other way round)
  refuses to start and says where the running one is. Without the lock, two
  hosts with the same device token would both start runs for the same mention.

### Before launch: unsigned builds, and the installer route

- Builds are **ad-hoc signed only**, the minimum macOS requires to run anything
  on Apple Silicon, **not** Developer ID signed or notarized. They already use
  the hardened runtime notarization will need, with the two entitlements the
  bundled Node can't run without (`allow-jit`,
  `allow-unsigned-executable-memory`). Without them, its JavaScript engine dies
  at startup. That was found by running it, not reading about it.
- **The instance's installer can install the app** (macOS first):
  ```bash
  curl -fsSL https://<instance>/install.sh | bash -s -- --app
  ```
  - The installer downloads `Fabrikka.app` (zipped) from the instance's
    `/downloads`, checks its SHA-256 against the `.sha256` file served beside
    it, and puts it in `~/Applications`.
  - **It needs no Node:** the app carries its own, so this path checks with the
    system's `shasum` and unpacks with `ditto`.
  - It writes the instance's address into the app's settings, so the first
    launch goes straight to sign-in.
  - A file fetched by `curl` isn't flagged by macOS as downloaded from the
    internet, so the app opens without the Gatekeeper prompt. That's legitimate
    only because the person chose to run this instance's installer. The same
    checks as ADR 0030 apply: HTTPS only, checksum, no `sudo`, nothing but
    Fabrikka's own files.
- A copy downloaded with a browser still works for testers, through **System
  Settings → Privacy & Security → Open Anyway**. The docs say so plainly, and
  don't ask customers to do it.
- **Windows and Linux** builds stay configured but unbuilt, as in M9: they need
  a build machine per platform.

### At launch: signing is a step, not an afterthought

Before the app is offered to customers:
- **macOS:** a Developer ID certificate (Apple Developer account) in place of
  the ad-hoc signature. The hardened runtime and Node's entitlements are already
  in place. Notarized with `notarytool`, with the ticket stapled. Browser downloads then open with a
  normal double-click.
- **Windows:** code signing (a certificate or Azure Trusted Signing), so
  SmartScreen doesn't warn.
- **In-app updates** (Tauri's updater, with its own signing key), replacing
  "re-run the installer". Until then, the app shows "update available" from the
  manifest, as the terminal host does.

## Consequences

- People who don't live in a terminal get the whole local side from one app: it
  pairs, picks folders, starts at login, and shows its state in the tray. The
  "dies with its terminal" gap closes.
- The `127.0.0.1` control page disappears in the app case, along with the attack
  surface it had to defend. It remains, defended as before, for the terminal host.
- The app download is large because Node rides along, and grows again with each
  platform.
- Two ways to run the host share one implementation, so the lock file is
  mandatory, not optional.
- The remote-window capability rule is load-bearing. A test asserts the main
  window can't invoke a host command.
- Until signing, the app is for the owner and testers. The installer route is a
  beta convenience, not a distribution strategy.

## Alternatives considered

**Rewrite the host in Rust.** Smallest and most native. Rejected: two
implementations of the folder policies and refusals, the part that must never
drift, with every change made twice.

**Require Node on the machine** and run the host from the system's Node. Small
download. Rejected: a desktop app that needs a developer tool installed first
misses the people the app is for.

**Load today's `127.0.0.1` page inside the app window.** Least work. Rejected: it
keeps a listening port open to every website the browser visits, which is the
attack surface the app can remove.

**Electron instead of Tauri.** Node comes built in, so there'd be no sidecar.
Rejected: it means replacing M9's shell and shipping Chromium too. The host is
cleanly a separate process anyway, and that separation is what keeps the remote
web app away from it.

**Sign from day one.** No Gatekeeper friction even for testers. Deferred: it's a
yearly cost and a certificate to protect, before there's anyone to ship to. The
installer route covers testing.
