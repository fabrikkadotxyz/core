/**
 * The client's address, for rate limits (docs/operations.md, "Behind a proxy").
 *
 * FABRIKKA_TRUSTED_PROXIES says how many proxies sit in front of the server.
 * Each appends the address it saw to X-Forwarded-For, so the client is the
 * entry that many places from the right, counting the socket's own peer as the
 * last proxy. Entries further left are whatever the client wrote, and ignored.
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export function parseTrustedProxies(value: string | undefined): number {
  const v = value?.trim() ?? '';
  if (v === '') return 0;
  if (!/^\d+$/.test(v) || Number(v) > 10) throw new Error(`FABRIKKA_TRUSTED_PROXIES must be a number of proxies, 0 to 10 (got "${v}")`);
  return Number(v);
}

const TRUSTED = parseTrustedProxies(process.env.FABRIKKA_TRUSTED_PROXIES);

/**
 * Pure, for tests: the socket's peer, the X-Forwarded-For header, and how many
 * proxies are trusted.
 */
export function pickClientIp(socket: string | undefined, forwardedFor: string | undefined, trusted: number): string {
  // Left to right: what the client claimed first, the socket's peer last.
  const chain = [
    ...(forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    socket ?? 'unknown',
  ];
  // Skip `trusted` hops from the right; never past the leftmost entry.
  return chain[Math.max(0, chain.length - 1 - trusted)]!;
}

export function clientIp(c: Context): string {
  const socket = getConnInfo(c).remote.address;
  if (TRUSTED === 0) return socket ?? 'unknown';
  return pickClientIp(socket, c.req.header('x-forwarded-for'), TRUSTED);
}

export const trustedProxies = TRUSTED;
