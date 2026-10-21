/**
 * The local client this instance serves, and its installer (M33, ADR 0030).
 *
 * Every instance serves the client it was built with: the bridge's single-file
 * bundle, a manifest with its SHA-256, and an install script with this
 * instance's address written in. So the client always matches its server, and
 * no third party is in the path.
 *
 * Nothing here is behind a login: an installer has to be reachable before you
 * have a computer connected. Nothing here is secret, either.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';

const DIST = resolve(import.meta.dirname, '../../../packages/bridge/dist');
/** M34, M57: the desktop apps, one file per platform, named by dist-app/apps.json. */
const APPS_DIR = resolve(import.meta.dirname, '../../../apps/desktop/dist-app');
const FILE = resolve(DIST, 'cli.js');
const NODE = '>=22';

/** The platforms an app is built for (ADR 0056), and the file each is served as. */
export const APP_PLATFORMS = {
  'darwin-arm64': 'Fabrikka-macos-arm64.zip',
  'darwin-x64': 'Fabrikka-macos-x64.zip',
  'linux-x64': 'Fabrikka-linux-x64.AppImage',
  'windows-x64': 'Fabrikka-windows-x64-setup.exe',
} as const;
export type AppPlatform = keyof typeof APP_PLATFORMS;

export interface AppFile {
  platform: AppPlatform;
  file: string;
  sha256: string;
  size: number;
  path: string;
}

export interface ClientRelease {
  version: string;
  sha256: string;
  size: number;
  bytes: Buffer;
}

let cached: { mtimeMs: number; release: ClientRelease } | null = null;

/** The client build next to this server, or null when there is none. Re-read when it's rebuilt. */
export async function clientRelease(): Promise<ClientRelease | null> {
  const info = await stat(FILE).catch(() => null);
  if (!info) return null;
  if (cached?.mtimeMs === info.mtimeMs) return cached.release;
  const bytes = await readFile(FILE);
  const version = await readFile(resolve(DIST, 'version.json'), 'utf8')
    .then((t) => (JSON.parse(t) as { version: string }).version)
    .catch(() => 'unversioned');
  const release = { version, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, bytes };
  cached = { mtimeMs: info.mtimeMs, release };
  return release;
}

let cachedApps: { key: string; apps: AppFile[] } | null = null;

/**
 * The desktop apps this instance serves (ADR 0056): the files dist-app/apps.json
 * names and that exist, each checked for a listed platform and a bare file
 * name. A folder holding only the old macOS zip (M34) counts as that platform.
 * Re-read when apps.json or a file changes.
 */
export async function appReleases(): Promise<AppFile[]> {
  const index = resolve(APPS_DIR, 'apps.json');
  const info = await stat(index).catch(() => null);
  let listed: { platform: string; file: string; sha256: string; size: number }[] = [];
  if (info) {
    try {
      listed = (JSON.parse(await readFile(index, 'utf8')) as { apps?: typeof listed }).apps ?? [];
    } catch {
      listed = [];
    }
  } else {
    const legacy = resolve(APPS_DIR, APP_PLATFORMS['darwin-arm64']);
    const zip = await stat(legacy).catch(() => null);
    if (!zip) return [];
    const sha = await readFile(`${legacy}.sha256`, 'utf8')
      .then((t) => t.trim().split(/\s+/)[0] ?? '')
      .catch(() => '');
    listed = [{ platform: 'darwin-arm64', file: APP_PLATFORMS['darwin-arm64'], sha256: sha, size: zip.size }];
  }
  const apps: AppFile[] = [];
  const key: string[] = [info ? String(info.mtimeMs) : 'legacy'];
  for (const a of listed) {
    if (!(a.platform in APP_PLATFORMS) || basename(a.file) !== a.file || !/^[0-9a-f]{64}$/.test(a.sha256)) continue;
    const path = resolve(APPS_DIR, a.file);
    const f = await stat(path).catch(() => null);
    if (!f) continue;
    key.push(`${a.file}:${f.mtimeMs}`);
    apps.push({ platform: a.platform as AppPlatform, file: a.file, sha256: a.sha256, size: f.size, path });
  }
  const k = key.join('|');
  if (cachedApps?.key === k) return cachedApps.apps;
  cachedApps = { key: k, apps };
  return apps;
}

/** A served app's bytes, as a stream: the installers are tens of megabytes each. */
export const appStream = (app: AppFile) => Readable.toWeb(createReadStream(app.path)) as ReadableStream;

/**
 * The app for a browser, by its user agent: Windows, Linux, or a Mac (the UA
 * does not say which chip, so Apple Silicon first; the installer reads uname).
 */
export function appFor(apps: AppFile[], userAgent: string | undefined): AppFile | null {
  const ua = userAgent ?? '';
  const want: AppPlatform[] = /Windows/i.test(ua) ? ['windows-x64'] : /Linux/i.test(ua) && !/Android/i.test(ua) ? ['linux-x64'] : /Macintosh|Mac OS/i.test(ua) ? ['darwin-arm64', 'darwin-x64'] : [];
  for (const w of want) {
    const found = apps.find((a) => a.platform === w);
    if (found) return found;
  }
  return null;
}

export function manifest(release: ClientRelease, publicUrl: string, apps: AppFile[] = []) {
  return {
    version: release.version,
    file: 'fabrikka.mjs',
    url: `${publicUrl}/downloads/fabrikka.mjs`,
    sha256: release.sha256,
    size: release.size,
    node: NODE,
    // M34, M57: the desktop apps, one per platform. Empty when this instance has none.
    apps: apps.map((a) => ({ platform: a.platform, file: a.file, url: `${publicUrl}/downloads/${a.file}`, sha256: a.sha256, size: a.size })),
  };
}

export const installCommand = (publicUrl: string) => `curl -fsSL ${publicUrl}/install.sh | bash`;
/** M57: Windows's line. PowerShell: irm is Invoke-RestMethod, iex Invoke-Expression. */
export const installCommandWindows = (publicUrl: string) => `irm ${publicUrl}/install.ps1 | iex`;

/** POSIX sh, single-quoted safely: the URL is the only thing interpolated. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The installer. Kept short enough to read before running it, which anyone
 * piping it into a shell should be able to do. See docs/security.md (M33).
 */
export function installScript(publicUrl: string): string {
  return `#!/bin/sh
# Fabrikka client installer for ${publicUrl}
# (ADR 0030). It installs only Fabrikka's own client, into your home folder,
# without sudo: never Node, never an agent runtime. Fabrikka is free software
# under the GNU AGPL v3 (https://www.gnu.org/licenses/agpl-3.0.html).
# Options, after "| bash -s --":
# With no option it installs the desktop app when this server has one for this
# computer (macOS or Linux; no Node needed), and the command-line client otherwise.
#   --client           install the command-line client (needs Node.js 22 or newer)
#   --app              install the desktop app, or stop if there is none for this computer
#   --no-connect       install only; don't start the host (or open the app)
#   --no-modify-path   don't add ~/.local/bin to your shell's startup file
set -eu

FABRIKKA_SERVER=${shQuote(publicUrl)}

say() { printf 'fabrikka: %s\\n' "$*"; }
die() { printf 'fabrikka: %s\\n' "$*" >&2; exit 1; }

main() {
  connect=1
  modify_path=1
  want=auto
  for arg in "$@"; do
    case "$arg" in
      --app) want=app ;;
      --client) want=client ;;
      --no-connect) connect=0 ;;
      --no-modify-path) modify_path=0 ;;
      *) die "unknown option: $arg" ;;
    esac
  done

  # An installer fetched over plain HTTP can be swapped in transit.
  case "$FABRIKKA_SERVER" in
    https://*) ;;
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\\[::1\\]|http://\\[::1\\]:*) ;;
    *) die "refusing to install from $FABRIKKA_SERVER: it isn't https" ;;
  esac

  if [ "$want" = auto ]; then
    if has_app; then want=app; else want=client; fi
  fi
  if [ "$want" = app ]; then
    install_app
    return
  fi

  command -v node >/dev/null 2>&1 || die "Fabrikka needs Node.js 22 or newer, and none was found. Install it from https://nodejs.org or your package manager, then run this again."
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "Fabrikka needs Node.js 22 or newer; this is $(node -v). Upgrade Node, then run this again."
  command -v curl >/dev/null 2>&1 || die "curl is needed"

  data="\${XDG_DATA_HOME:-$HOME/.local/share}/fabrikka"
  bin="$HOME/.local/bin"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  say "downloading the client from $FABRIKKA_SERVER"
  curl -fsSL "$FABRIKKA_SERVER/downloads/manifest.json" -o "$tmp/manifest.json" || die "this server serves no client"
  # Node is here anyway: let it read the JSON.
  field() { node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(m[process.argv[2]])' "$tmp/manifest.json" "$1"; }
  version=$(field version)
  expected=$(field sha256)
  curl -fsSL "$(field url)" -o "$tmp/fabrikka.mjs" || die "the download failed"

  # Refuse anything that isn't byte-for-byte what the manifest names.
  actual=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp/fabrikka.mjs")
  [ "$actual" = "$expected" ] || die "the download doesn't match its checksum, so nothing was installed"

  mkdir -p "$data" "$bin"
  mv "$tmp/fabrikka.mjs" "$data/fabrikka.mjs"
  printf '#!/bin/sh\\nexec node "%s/fabrikka.mjs" "$@"\\n' "$data" > "$bin/fabrikka"
  chmod +x "$bin/fabrikka"
  say "installed fabrikka $version in $bin"

  case ":$PATH:" in
    *":$bin:"*) ;;
    *)
      if [ "$modify_path" = 1 ]; then
        case "\${SHELL:-}" in
          */zsh) rc="$HOME/.zshrc" ;;
          *) rc="$HOME/.bashrc" ;;
        esac
        line='export PATH="$HOME/.local/bin:$PATH" # added by the Fabrikka installer'
        if ! grep -qF '# added by the Fabrikka installer' "$rc" 2>/dev/null; then
          printf '\\n%s\\n' "$line" >> "$rc"
          say "added ~/.local/bin to your PATH in $rc (new terminals pick it up)"
        fi
      else
        say "~/.local/bin isn't on your PATH: add it, or run $bin/fabrikka"
      fi
      ;;
  esac

  # Agent tools are yours to install (ADR 0002): say what's here, change nothing.
  found=""
  command -v claude >/dev/null 2>&1 && found="$found Claude Code"
  command -v codex >/dev/null 2>&1 && found="$found Codex"
  command -v opencode >/dev/null 2>&1 && found="$found OpenCode"
  if [ -n "$found" ]; then say "agent tools found:$found"; else say "no agent tools found yet: install Claude Code, Codex or OpenCode to run agents here"; fi

  if [ "$connect" = 1 ]; then
    say "connecting this computer to $FABRIKKA_SERVER: your browser will open"
    exec "$bin/fabrikka" host --server "$FABRIKKA_SERVER"
  fi
  say "done. Connect this computer with: fabrikka host"
}

# The app's file for this computer's platform, or nothing.
app_file() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo ${APP_PLATFORMS['darwin-arm64']} ;;
    Darwin-x86_64) echo ${APP_PLATFORMS['darwin-x64']} ;;
    Linux-x86_64) echo ${APP_PLATFORMS['linux-x64']} ;;
    *) return 1 ;;
  esac
}

# ADR 0056, amended: with no option, the app when this server serves one here.
has_app() {
  file=$(app_file) || return 1
  command -v curl >/dev/null 2>&1 || return 1
  if curl -fsSL -o /dev/null "$FABRIKKA_SERVER/downloads/$file.sha256"; then return 0; fi
  say "this server has no desktop app for this computer, so this installs the command-line client"
  return 1
}

# The desktop app (M34, ADR 0031; every desktop since M57, ADR 0056): it
# carries its own Node, so nothing here needs one. The checksum is the
# system's; the file is the one for this computer's platform.
install_app() {
  os=$(uname -s); arch=$(uname -m)
  file=$(app_file) || die "no desktop app for $os on $arch yet. Run this again with --client to install the command-line client."
  command -v curl >/dev/null 2>&1 || die "curl is needed"
  if command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
  elif command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
  else die "shasum or sha256sum is needed"; fi

  url="$FABRIKKA_SERVER/downloads/$file"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url.sha256" -o "$tmp/app.sha256" || die "this server has no desktop app for $os on $arch. Run this again with --client to install the command-line client."
  expected=$(cut -d' ' -f1 < "$tmp/app.sha256")
  say "downloading the desktop app from $FABRIKKA_SERVER"
  curl -fsSL "$url" -o "$tmp/$file" || die "the download failed"
  actual=$(sum "$tmp/$file")
  [ "$actual" = "$expected" ] || die "the download doesn't match its checksum, so nothing was installed"

  if [ "$os" = Darwin ]; then install_app_mac "$tmp/$file"; else install_app_linux "$tmp/$file"; fi
}

install_app_mac() {
  command -v ditto >/dev/null 2>&1 || die "ditto is needed"
  apps="$HOME/Applications"
  mkdir -p "$apps"
  rm -rf "$apps/Fabrikka.app"
  ditto -x -k "$1" "$apps"
  say "installed Fabrikka.app in $apps"

  # Point the app at this instance, so its first launch goes straight to sign-in.
  settings="$HOME/Library/Application Support/xyz.fabrikka.app"
  mkdir -p "$settings"
  printf '%s' "$FABRIKKA_SERVER" > "$settings/server-url"

  if [ "$connect" = 1 ]; then
    say "opening Fabrikka"
    open "$apps/Fabrikka.app"
  else
    say "done. Open Fabrikka from $apps"
  fi
}

# Linux: the AppImage into ~/.local/bin, and a launcher entry. No package, no root.
install_app_linux() {
  bin="$HOME/.local/bin"
  mkdir -p "$bin" "$HOME/.local/share/applications"
  mv "$1" "$bin/fabrikka-app"
  chmod +x "$bin/fabrikka-app"
  cat > "$HOME/.local/share/applications/fabrikka.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Fabrikka
Comment=A private session layer for humans and AI agents
Exec=$bin/fabrikka-app
Terminal=false
Categories=Development;
DESKTOP
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
  say "installed Fabrikka as $bin/fabrikka-app, and in your launcher"
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
    say "note: AppImages need libfuse2; add it with your package manager. Until then, run it with APPIMAGE_EXTRACT_AND_RUN=1 $bin/fabrikka-app"
  fi

  settings="\${XDG_CONFIG_HOME:-$HOME/.config}/xyz.fabrikka.app"
  mkdir -p "$settings"
  printf '%s' "$FABRIKKA_SERVER" > "$settings/server-url"

  if [ "$connect" = 1 ]; then
    say "opening Fabrikka"
    if command -v setsid >/dev/null 2>&1; then setsid "$bin/fabrikka-app" >/dev/null 2>&1 < /dev/null &
    else nohup "$bin/fabrikka-app" >/dev/null 2>&1 < /dev/null & fi
  else
    say "done. Open Fabrikka from your launcher, or run $bin/fabrikka-app"
  fi
}

# Called on the last line, so a download cut short can't run half an installer.
main "$@"
`;
}

/** PowerShell single-quoted: a quote doubles. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The Windows installer (M57, ADR 0056): `irm <instance>/install.ps1 | iex`.
 * The same shape as the shell script: the instance's address written in, https
 * or localhost only, the manifest's checksum or nothing, nothing elevated, one
 * function called at the end. PowerShell 5.1 and 7. No backticks: they are
 * PowerShell's escape character and read badly inside a template literal.
 */
export function installScriptWindows(publicUrl: string): string {
  return `# Fabrikka installer for ${publicUrl}, for Windows (ADR 0056).
# It installs only Fabrikka's own app or client, for your user, never elevated:
# never Node for you, never an agent runtime. Fabrikka is free software under
# the GNU AGPL v3 (https://www.gnu.org/licenses/agpl-3.0.html).
# Before running:  $env:FABRIKKA_INSTALL='client'   the command-line client instead of the app (needs Node.js 22+)
#                  $env:FABRIKKA_NO_CONNECT='1'     install only; open nothing
$ErrorActionPreference = 'Stop'
$Server = ${psQuote(publicUrl)}

function Say($m) { Write-Host "fabrikka: $m" }
function Die($m) { Write-Host "fabrikka: $m" -ForegroundColor Red; exit 1 }

function Get-Sha256($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

function Install-App($manifest, $connect) {
  $entry = $manifest.apps | Where-Object { $_.platform -eq 'windows-x64' } | Select-Object -First 1
  if (-not $entry) { Die ('this server has no desktop app for Windows yet. Set $env:FABRIKKA_INSTALL=''client'' and run this again to install the command-line client (needs Node.js 22 or newer).') }
  $tmp = Join-Path $env:TEMP ("fabrikka-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $setup = Join-Path $tmp $entry.file
    Say "downloading the desktop app from $Server"
    Invoke-WebRequest -Uri $entry.url -OutFile $setup -UseBasicParsing
    if ((Get-Sha256 $setup) -ne $entry.sha256.ToLower()) { Die "the download doesn't match its checksum, so nothing was installed" }
    # Verified above; the mark-of-the-web would only make SmartScreen refuse what the checksum passed.
    Unblock-File -Path $setup
    Say "installing Fabrikka for your user (no administrator prompt)"
    $p = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { Die "the installer stopped with code $($p.ExitCode)" }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  # Point the app at this instance, so its first launch goes straight to sign-in.
  $settings = Join-Path $env:APPDATA 'xyz.fabrikka.app'
  New-Item -ItemType Directory -Path $settings -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $settings 'server-url'), $Server)

  $dir = Join-Path $env:LOCALAPPDATA 'Fabrikka'
  $exe = Get-ChildItem -Path $dir -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'uninstall' } | Select-Object -First 1
  Say "installed Fabrikka in $dir"
  if ($connect -and $exe) {
    Say "opening Fabrikka"
    Start-Process -FilePath $exe.FullName
  } else {
    Say "done. Open Fabrikka from the Start menu"
  }
}

function Install-Client($manifest, $connect) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Die "Fabrikka needs Node.js 22 or newer, and none was found. Install it from https://nodejs.org, then run this again." }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 22) { Die "Fabrikka needs Node.js 22 or newer; this is $(& node -v). Upgrade Node, then run this again." }

  $data = Join-Path $env:LOCALAPPDATA 'fabrikka'
  $bin = Join-Path $data 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $tmp = Join-Path $data 'fabrikka.mjs.download'
  Say "downloading the client from $Server"
  Invoke-WebRequest -Uri $manifest.url -OutFile $tmp -UseBasicParsing
  # Refuse anything that isn't byte-for-byte what the manifest names.
  if ((Get-Sha256 $tmp) -ne $manifest.sha256.ToLower()) { Remove-Item $tmp -Force; Die "the download doesn't match its checksum, so nothing was installed" }
  Move-Item -Path $tmp -Destination (Join-Path $data 'fabrikka.mjs') -Force
  $shim = Join-Path $bin 'fabrikka.cmd'
  $nl = [Environment]::NewLine
  [IO.File]::WriteAllText($shim, '@echo off' + $nl + 'node "%LOCALAPPDATA%\\fabrikka\\fabrikka.mjs" %*' + $nl)
  Say "installed fabrikka $($manifest.version) in $bin"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $bin)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath, $bin) -join ';').Trim(';'), 'User')
    Say "added $bin to your PATH (new terminals pick it up)"
  }
  $env:Path = "$env:Path;$bin"

  # Agent tools are yours to install (ADR 0002): say what's here, change nothing.
  $found = @()
  foreach ($t in @(@('claude', 'Claude Code'), @('codex', 'Codex'), @('opencode', 'OpenCode'))) { if (Get-Command $t[0] -ErrorAction SilentlyContinue) { $found += $t[1] } }
  if ($found.Count -gt 0) { Say ("agent tools found: " + ($found -join ', ')) } else { Say "no agent tools found yet: install Claude Code, Codex or OpenCode to run agents here" }

  if ($connect) {
    Say "connecting this computer to $Server: your browser will open"
    & $shim host --server $Server
  } else {
    Say "done. Connect this computer with: fabrikka host"
  }
}

function Main {
  # An installer fetched over plain HTTP can be swapped in transit.
  if ($Server -notmatch '^https://' -and $Server -notmatch '^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?$') { Die "refusing to install from $Server: it isn't https" }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
  $connect = $env:FABRIKKA_NO_CONNECT -ne '1'
  try { $manifest = Invoke-RestMethod -Uri "$Server/downloads/manifest.json" -UseBasicParsing } catch { Die "this server serves no client" }
  if ($env:FABRIKKA_INSTALL -eq 'client') { Install-Client $manifest $connect } else { Install-App $manifest $connect }
}

# Called on the last line, so a download cut short can't run half an installer.
Main
`;
}
