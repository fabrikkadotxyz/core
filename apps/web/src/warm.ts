/**
 * What this tab last showed (ADR 0044), so a reload paints at once and then
 * asks the server. A copy for drawing, never for deciding: the server checks
 * every action as before.
 *
 * sessionStorage, not localStorage: it lives as long as the tab, so a closed
 * tab leaves nothing behind. Signing out clears it.
 */
const PREFIX = 'fabrikka.warm.';

export function readWarm<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(PREFIX + key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

export function writeWarm(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full or blocked: the next reload waits for the server, as it used to.
  }
}

export function clearWarm(): void {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch {
    // Nothing was kept.
  }
}
