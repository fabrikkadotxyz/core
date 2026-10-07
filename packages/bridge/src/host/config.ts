/**
 * The host's own config (M31, ADR 0027): the server, the device token, and the
 * folders granted on this machine with their policies. Paths and policies live
 * here and nowhere else — the server only ever learns grant ids and labels.
 *
 * Stored at ~/.fabrikka/host.json, readable only by you (mode 0600).
 * FABRIKKA_HOST_HOME moves it (tests, several hosts on one machine).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '../spawn.ts';

export interface Grant {
  /** Opaque, minted here. The server sees this and the label, never the path. */
  id: string;
  label: string;
  path: string;
  policy: Policy;
}

export interface HostConfig {
  server: string;
  deviceName: string;
  deviceToken?: string;
  grants: Grant[];
}

export const HOST_HOME = process.env.FABRIKKA_HOST_HOME ?? join(homedir(), '.fabrikka');
const FILE = join(HOST_HOME, 'host.json');

/**
 * The name people know this computer by. On macOS the hostname can be just a
 * network address ("192.168.0.20"), while the Computer Name in Sharing settings
 * is "Ada's MacBook Pro" — ask for that. Elsewhere, the hostname.
 */
function defaultDeviceName(): string {
  if (process.platform === 'darwin') {
    const r = spawnSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' });
    const name = r.status === 0 ? r.stdout.trim() : '';
    if (name) return name;
  }
  return hostname().replace(/\.local$/, '');
}

export function loadHostConfig(server?: string): HostConfig {
  let cfg: Partial<HostConfig> = {};
  if (existsSync(FILE)) {
    try {
      cfg = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<HostConfig>;
    } catch {
      cfg = {};
    }
  }
  const resolved = server ?? cfg.server ?? process.env.FABRIKKA_SERVER ?? 'http://localhost:9090';
  return {
    server: resolved,
    deviceName: cfg.deviceName ?? defaultDeviceName(),
    // A device token belongs to the server that issued it: pointed at another
    // server, this machine pairs again. Its folder grants are the machine's and stay.
    deviceToken: cfg.server && cfg.server !== resolved ? undefined : cfg.deviceToken,
    grants: Array.isArray(cfg.grants) ? cfg.grants : [],
  };
}

export function saveHostConfig(cfg: HostConfig): void {
  mkdirSync(HOST_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // writeFileSync keeps an existing file's mode; make sure it's owner-only.
  chmodSync(FILE, 0o600);
}
