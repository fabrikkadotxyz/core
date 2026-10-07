/**
 * A fixed-window rate limiter, in memory (M32, ADR 0029).
 *
 * Per process, which is right for one server process: a second process needs it
 * in Postgres, as the turn budget is (M6). Keys are whatever the caller limits
 * on — "reset:email:<address>", "reset:ip:<address>".
 */
const windows = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;

/** True while `key` is under `max` hits in the current window; counts this hit. */
export function rateLimit(key: string, { max, windowMs }: { max: number; windowMs: number }): boolean {
  const now = Date.now();
  // Drop expired windows now and then, so the map can't grow without bound.
  if (now - lastSweep > 60_000) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    lastSweep = now;
  }
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  w.count += 1;
  return w.count <= max;
}
