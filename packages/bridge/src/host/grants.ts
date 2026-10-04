/**
 * Which folders may be granted (ADR 0027): a project, never a machine. A home
 * directory, a filesystem root, or anything containing one of them is refused.
 * Paths are resolved through symlinks first, so a link can't smuggle one in.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, parse, resolve, sep } from 'node:path';

export function checkGrantPath(input: string): { ok: true; path: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'choose a folder' };
  const expanded = raw === '~' || raw.startsWith(`~${sep}`) || raw.startsWith('~/') ? homedir() + raw.slice(1) : raw;
  let real: string;
  try {
    real = realpathSync(resolve(expanded));
  } catch {
    return { ok: false, error: 'that folder does not exist' };
  }
  if (!statSync(real).isDirectory()) return { ok: false, error: 'that is a file, not a folder' };

  const home = realpathSync(homedir());
  if (real === parse(real).root) return { ok: false, error: 'a whole disk cannot be granted — choose a project folder' };
  if (real === home) return { ok: false, error: 'your home folder cannot be granted — choose a project folder inside it' };
  if (home.startsWith(real + sep)) return { ok: false, error: 'that folder contains your home folder — choose a project folder' };
  return { ok: true, path: real };
}

export function newGrantId(): string {
  return randomBytes(9).toString('base64url');
}

export function defaultLabel(path: string): string {
  return basename(path) || path;
}
