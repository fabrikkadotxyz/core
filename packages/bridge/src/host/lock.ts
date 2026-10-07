/**
 * One host per machine (M34, ADR 0031). The desktop app and `fabrikka host`
 * share ~/.fabrikka and its device token: two running together would both start
 * runs for the same mention. The lock holds the owner's pid; a stale lock (its
 * process gone) is taken over.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_HOME } from './config.ts';

const FILE = join(HOST_HOME, 'host.lock');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but isn't ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Take the lock, or return why not. Released on exit. */
export function acquireHostLock(): { ok: true } | { ok: false; holder: number } {
  mkdirSync(HOST_HOME, { recursive: true, mode: 0o700 });
  try {
    const holder = Number(readFileSync(FILE, 'utf8').trim());
    if (holder && holder !== process.pid && alive(holder)) return { ok: false, holder };
  } catch {
    // no lock yet
  }
  writeFileSync(FILE, String(process.pid), { mode: 0o600 });
  // Only remove it if it's still ours: a newer host may have taken over a stale one.
  process.on('exit', () => {
    try {
      if (readFileSync(FILE, 'utf8').trim() === String(process.pid)) unlinkSync(FILE);
    } catch {
      // already gone
    }
  });
  return { ok: true };
}
