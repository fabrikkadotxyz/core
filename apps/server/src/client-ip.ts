/**
 * The client's address, for rate limits (docs/operations.md, "Behind a proxy").
 *
 * FABRIKKA_TRUSTED_PROXIES says how many proxies sit in front of the server.
 * Each appends the address it saw to X-Forwarded-For, so the client is the
 * entry that many places from the right, counting the socket's own peer as the
 * last proxy. Entries further left are whatever the client wrote, and ignored.
 *
 * FABRIKKA_CLIENT_IP_HEADER instead names a header the platform's proxy sets
 * itself (Fly.io: Fly-Client-IP), and wins over the count.
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

export function parseClientIpHeader(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  if (v === '') return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new Error(`FABRIKKA_CLIENT_IP_HEADER must be a header name (got "${v}")`);
  return v.toLowerCase();
}

const HEADER = parseClientIpHeader(process.env.FABRIKKA_CLIENT_IP_HEADER);

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

/** Pure, for tests: the platform header's value, or the socket's when it's missing. */
export function fromPlatformHeader(socket: string | undefined, value: string | undefined): string {
  const v = value?.trim();
  return v && v.length <= 64 ? v : (socket ?? 'unknown');
}

export function clientIp(c: Context): string {
  const socket = getConnInfo(c).remote.address;
  if (HEADER) return fromPlatformHeader(socket, c.req.header(HEADER));
  if (TRUSTED === 0) return socket ?? 'unknown';
  return pickClientIp(socket, c.req.header('x-forwarded-for'), TRUSTED);
}

export const trustedProxies = TRUSTED;
export const clientIpHeader = HEADER;
