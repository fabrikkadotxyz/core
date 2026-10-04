/**
 * The host's own config (M31, ADR 0027): the server, the device token, and the
 * folders granted on this machine with their policies. Paths and policies live
 * here and nowhere else — the server only ever learns grant ids and labels.
 *
 * Stored at ~/.fabrikka/host.json, readable only by you (mode 0600).
 * FABRIKKA_HOST_HOME moves it (tests, several hosts on one machine).
 */
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

export function loadHostConfig(server?: string): HostConfig {
  let cfg: Partial<HostConfig> = {};
  if (existsSync(FILE)) {
    try {
      cfg = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<HostConfig>;
    } catch {
      cfg = {};
    }
  }
  return {
    server: server ?? cfg.server ?? process.env.FABRIKKA_SERVER ?? 'http://localhost:9090',
    deviceName: cfg.deviceName ?? hostname().replace(/\.local$/, ''),
    deviceToken: cfg.deviceToken,
    grants: Array.isArray(cfg.grants) ? cfg.grants : [],
  };
}

export function saveHostConfig(cfg: HostConfig): void {
  mkdirSync(HOST_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // writeFileSync keeps an existing file's mode; make sure it's owner-only.
  chmodSync(FILE, 0o600);
}
