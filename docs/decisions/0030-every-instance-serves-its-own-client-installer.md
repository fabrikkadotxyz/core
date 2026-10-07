# 0030 — Every instance serves its own client, with a one-line installer

**Status:** Proposed
**Date:** 2026-10-07

## Context

The local client (`fabrikka`, the bridge package: the local host of M31, the
runner and the channel bridge) is how a person's own machine joins sessions. It
can't be installed today. It isn't on npm, and the only way to get it is to
clone the monorepo and build it. Every generated
command defaults to `npx -y @fabrikka/bridge`, which fails.

For a hosted instance that blocks everything: a person who signed up has no
way to connect their computer. A self-hosted instance has the same problem in
a different form. Its users need a client that matches *that*
server's version, and they shouldn't depend on a third party being reachable.

People expect one line, the way Google's Antigravity CLI installs:
`curl -fsSL https://antigravity.google/cli/install.sh | bash`. That script (read
before writing this ADR):
- detects the platform;
- reads a manifest;
- downloads a native binary;
- **refuses it unless its SHA-512 matches**;
- puts it in `~/.local/bin`;
- clears macOS's quarantine flag;
- runs a setup step.

Two ways to get there were weighed:
- **A, require Node:** ship the single JavaScript file the bridge already builds
  to.
- **B, standalone binaries:** the runtime packed in, about 50–100 MB per
  platform, signed and notarized for macOS.

This ADR takes A.

## Decision

**The client ships as one JavaScript file that needs Node 22 or newer. Every
instance serves that file, a manifest and an install script built for itself,
so connecting a computer is one command copied from the instance's own page,
and the client always matches the server it talks to. The same file is
published to npm for people who prefer `npx`.**

### The artifact: one file for every platform

- The bridge's esbuild output becomes fully self-contained by **bundling `ws`**
  as well. Its optional native add-ons (`bufferutil`, `utf-8-validate`) stay
  out, and `ws` already loads them inside `try`/`catch` and falls back without
  them.
- One file, about 1.5 MB, the same bytes on macOS, Linux and Windows. It needs
  **Node 22 or newer**: 22 is the oldest Node release line still maintained (20
  reached end of life in April 2026).

### Served by the instance, for the instance

The core serves three public, unauthenticated routes, built from the bridge it
was released with:

| Route | What it is |
| --- | --- |
| `GET /install.sh` | The installer for macOS and Linux, with **this instance's public URL written into it** as the server to connect to. |
| `GET /downloads/manifest.json` | `{ version, file, sha256, size, node: ">=22" }`. |
| `GET /downloads/fabrikka.mjs` | The client itself. |

So a hosted instance's command is `curl -fsSL https://app.<domain>/install.sh
| bash`, and a self-hosted company's is the same with its own address. There is
no release host to run and no third party in the path. A new server release
carries its own client.

### What the install script does, and doesn't

1. **Refuses plain `http://`** for anything but `localhost`. An installer
   fetched over HTTP can be swapped in transit.
2. **Checks for Node 22 or newer.** Without it, it says how to get Node and
   stops. **It installs nothing but Fabrikka's own client:** never Node, never
   an agent runtime. Claude Code and Codex are the user's (ADR 0002). It
   reports whether `claude` and `codex` are on the PATH, so the user knows
   before their first mention.
3. **Downloads the manifest and the file, and refuses the file unless its
   SHA-256 matches.**
4. **Installs into the user's home, never with `sudo`.** The file goes to
   `~/.local/share/fabrikka/`, and a small `fabrikka` launcher to
   `~/.local/bin/`. If that folder isn't on the PATH, it adds one marked line to
   the shell's startup file (`~/.zshrc` or `~/.bashrc`) and says so.
   `--no-modify-path` skips that.
5. **Connects:** it ends by starting `fabrikka host --server <this instance>`,
   which opens the browser at the pairing page (M31). Installing and connecting
   a computer is then one pasted command and one click. `--no-connect` installs
   only.

The whole script is wrapped in a function called on its last line, so a
download cut short can't run half an installer.

### Where people find it

*Your devices* (M31) shows the command for this instance with a **Copy**
button. A device is set up once per machine, so it falls under the five-click
rule's allowance for one-time setup.

### Updates

`fabrikka update` reads the manifest of the server the client is paired with,
verifies the new file's checksum, and replaces it. When the host connects, the
server sends its client's version, and an out-of-date host says so in its
terminal and on its local page. It never updates itself silently.

### npm, as a second channel

The same file is published as `@fabrikka/bridge`, with a `fabrikka` command,
so `npx @fabrikka/bridge host --server <url>` works anywhere npm does. This also
makes the default `BRIDGE_COMMAND` real. Publishing is the owner's decision,
because it makes the package public. Everything above works without it.

### Windows

The same file runs there under Node, through npm. A PowerShell installer
(`/install.ps1`, used as `irm … | iex`) is left for later: the local host hasn't
been tested on Windows yet (M31 was verified on macOS).

## Consequences

- The client and the server never drift: whoever runs a server version gets that
  version's client, from that server.
- One file, no build matrix, no signing keys. The cost is that **Node 22+ is a
  prerequisite**. Developers usually have it; the script says plainly what to
  do when they don't.
- **The checksum protects against a corrupted or cut-off download, not against
  a compromised server**, because the script, the manifest and the file come from
  the same origin. HTTPS is what protects the path. A signature from a key the
  server doesn't hold (option B's territory) is the stronger step, and can be
  added to the manifest later.
- Editing the user's shell startup file is invasive. It's one marked line,
  announced, and skippable.
- Standalone binaries (B) can be added later under the same routes: the
  manifest gains a per-platform `files` list, and the command people type
  doesn't change.

## Alternatives considered

**B: standalone binaries now** (Node's single-executable applications, or Bun's
compile). Nothing to have installed, just like Antigravity. Deferred: about
50–100 MB per platform, a build per platform, and code signing plus
notarization (an Apple Developer account) to install on macOS without a
warning. The same routes can carry them later.

**GitHub Releases on a public repository**, with one installer for everyone.
The common shape. Rejected as the primary path: a self-hosted instance would
depend on GitHub being reachable and on a client version chosen elsewhere, and
the instance's address would have to be typed as a flag rather than written
into the script.

**npm only.** Least work. Rejected as the only path: `npx` prints package-manager
noise, caches unpredictably, and can't write the instance's address in for the
user. It stays as the second channel.

**Homebrew tap, apt/rpm repositories.** Familiar to many. Later, if demand shows
up. Each is a channel to maintain per package manager, and none knows which
instance you belong to.
