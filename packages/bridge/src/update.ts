/**
 * `fabrikka update` (M33, ADR 0030): install the client the server you're paired
 * with now serves. Never automatic — the host only says an update is available.
 *
 * Only a copy the installer put in place is replaced: one from npm, or a build
 * inside a checkout, belongs to whatever installed it.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadHostConfig } from './host/config.ts';
import { VERSION } from './version.ts';

/** Where the installer puts the client file. Mirrors install.sh. */
export function installedPath(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'fabrikka', 'fabrikka.mjs');
}

const isLocal = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

export async function update(argv: string[], log: (...a: unknown[]) => void): Promise<number> {
  const i = argv.indexOf('--server');
  const server = (i >= 0 ? argv[i + 1] : undefined) ?? loadHostConfig().server;
  const base = new URL(server);
  if (base.protocol !== 'https:' && !isLocal(base)) {
    log(`refusing to update from ${server}: not https`);
    return 1;
  }

  const target = installedPath();
  let running = '';
  try {
    running = realpathSync(process.argv[1] ?? '');
  } catch {
    // fall through: not the installed copy
  }
  let installed = target;
  try {
    installed = realpathSync(target);
  } catch {
    // not installed at all: `running` can't match
  }
  if (running !== installed) {
    log(`this copy of fabrikka (${running || 'unknown'}) wasn't installed by the installer, so it isn't replaced.`);
    log(`update it the way you installed it, or install with: curl -fsSL ${base.origin}/install.sh | bash`);
    return 1;
  }

  const res = await fetch(new URL('/downloads/manifest.json', base)).catch(() => null);
  if (!res?.ok) {
    log(`${base.origin} serves no client (${res ? res.status : 'unreachable'})`);
    return 1;
  }
  const manifest = (await res.json()) as { version: string; url: string; sha256: string };
  if (manifest.version === VERSION) {
    log(`already up to date (${VERSION})`);
    return 0;
  }

  const file = await fetch(manifest.url).catch(() => null);
  if (!file?.ok) {
    log(`could not download ${manifest.url}`);
    return 1;
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.sha256) {
    log(`the download doesn't match the manifest's checksum — nothing was changed`);
    return 1;
  }

  // Write beside the target and rename over it: an interrupted update leaves the
  // old client working, never half a new one.
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o755 });
  await rename(tmp, target);
  log(`updated ${VERSION} → ${manifest.version}. Restart \`fabrikka host\` to use it.`);
  return 0;
}
