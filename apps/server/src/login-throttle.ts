/**
 * Guessing passwords (M59). A fixed window of *failed* sign-ins per address and
 * per client, in memory like rate-limit.ts. Successes cost nothing, so a team
 * that signs in often is never locked by its own habit; only failures count.
 *
 * Once a window is full, every attempt is refused with the same answer as a
 * wrong password, the right password included, until the window passes. The
 * answer never says "locked": that would tell a guesser the address exists.
 * docs/security.md, "Guessing passwords".
 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Failed sign-ins one address takes in a window before it is refused. */
export const LOGIN_MAX_PER_EMAIL = 10;
/** Failed sign-ins one client takes in a window, across addresses. */
export const LOGIN_MAX_PER_CLIENT = 100;

interface Window {
  count: number;
  resetAt: number;
}

export interface LoginThrottle {
  /** May this address and client try? False once either window is full. */
  allowed(email: string, ip: string): boolean;
  /** Count one failure against both. */
  failed(email: string, ip: string): void;
  /** How many failures the address has in its window; for the operator's log. */
  failuresFor(email: string): number;
}

/** One throttle per process; the clock is a parameter so a test can move time. */
export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const windows = new Map<string, Window>();
  let lastSweep = 0;
  const keyEmail = (email: string) => `email:${email.trim().toLowerCase()}`;
  const keyIp = (ip: string) => `ip:${ip}`;

  const live = (key: string): Window | undefined => {
    const t = now();
    if (t - lastSweep > 60_000) {
      for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      lastSweep = t;
    }
    const w = windows.get(key);
    if (!w || w.resetAt <= t) return undefined;
    return w;
  };
  const bump = (key: string) => {
    const w = live(key);
    if (w) w.count += 1;
    else windows.set(key, { count: 1, resetAt: now() + LOGIN_WINDOW_MS });
  };

  return {
    allowed(email, ip) {
      const e = live(keyEmail(email));
      if (e && e.count >= LOGIN_MAX_PER_EMAIL) return false;
      const c = live(keyIp(ip));
      if (c && c.count >= LOGIN_MAX_PER_CLIENT) return false;
      return true;
    },
    failed(email, ip) {
      bump(keyEmail(email));
      bump(keyIp(ip));
    },
    failuresFor(email) {
      return live(keyEmail(email))?.count ?? 0;
    },
  };
}

export const loginThrottle = createLoginThrottle();
