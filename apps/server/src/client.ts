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
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '../../../packages/bridge/dist');
const FILE = resolve(DIST, 'cli.js');
const NODE = '>=22';

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

export function manifest(release: ClientRelease, publicUrl: string) {
  return {
    version: release.version,
    file: 'fabrikka.mjs',
    url: `${publicUrl}/downloads/fabrikka.mjs`,
    sha256: release.sha256,
    size: release.size,
    node: NODE,
  };
}

export const installCommand = (publicUrl: string) => `curl -fsSL ${publicUrl}/install.sh | bash`;

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
# without sudo: never Node, never an agent runtime. Options, after "| bash -s --":
#   --no-connect       install only; run \`fabrikka host\` later
#   --no-modify-path   don't add ~/.local/bin to your shell's startup file
set -eu

FABRIKKA_SERVER=${shQuote(publicUrl)}

say() { printf 'fabrikka: %s\\n' "$*"; }
die() { printf 'fabrikka: %s\\n' "$*" >&2; exit 1; }

main() {
  connect=1
  modify_path=1
  for arg in "$@"; do
    case "$arg" in
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
  if [ -n "$found" ]; then say "agent tools found:$found"; else say "no agent tools found yet: install Claude Code or Codex to run agents here"; fi

  if [ "$connect" = 1 ]; then
    say "connecting this computer to $FABRIKKA_SERVER: your browser will open"
    exec "$bin/fabrikka" host --server "$FABRIKKA_SERVER"
  fi
  say "done. Connect this computer with: fabrikka host"
}

# Called on the last line, so a download cut short can't run half an installer.
main "$@"
`;
}
