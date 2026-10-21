/**
 * Session event bus.
 *
 * Fans server events out to everything watching a session. In M0 the only
 * subscribers are browser WebSockets; at M4 bridge connections subscribe here
 * too, which is why this is a session-keyed bus and not a socket registry.
 *
 * In-process only. A multi-instance deployment needs Postgres LISTEN/NOTIFY or
 * Redis behind this same interface — deliberately not built yet.
 */
import type { ServerEvent } from '@fabrikka/types';

type Subscriber = (event: ServerEvent) => void;

const subscribers = new Map<string, Set<Subscriber>>();

/** Returns an unsubscribe function. */
export function subscribe(sessionId: string, fn: Subscriber): () => void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(fn);

  return () => {
    set!.delete(fn);
    if (set!.size === 0) subscribers.delete(sessionId);
  };
}

/**
 * M42: listeners for every session's events, so a person's stream can hear the
 * rooms they aren't looking at. Returns an unsubscribe function.
 */
type AnySubscriber = (sessionId: string, event: ServerEvent) => void;
const anySubscribers = new Set<AnySubscriber>();
export function subscribeAll(fn: AnySubscriber): () => void {
  anySubscribers.add(fn);
  return () => void anySubscribers.delete(fn);
}

export function publish(sessionId: string, event: ServerEvent): void {
  for (const fn of anySubscribers) {
    try {
      fn(sessionId, event);
    } catch (err) {
      console.error('[bus] subscriber threw', err);
    }
  }
  const set = subscribers.get(sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (err) {
      // One bad subscriber must not stop delivery to the others.
      console.error('[bus] subscriber threw', err);
    }
  }
}
