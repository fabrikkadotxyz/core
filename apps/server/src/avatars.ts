/**
 * Profile pictures (M67, ADR 0061). The browser crops and re-encodes; the
 * server trusts none of that: it recognises PNG, JPEG or WebP by their first
 * bytes, caps the size, and stores the bytes in the file store by content
 * under avatars/. A picture is the one thing in the store that is deleted:
 * when replaced, removed, or its account deleted, unless another account
 * holds the identical bytes.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { users } from '@fabrikka/db';
import { avatarKey, files } from './file-store.ts';

export const MAX_AVATAR_BYTES = 512 * 1024;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

/** What the bytes are, whatever the name or the declared type says. Never SVG. */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Where a picture is served, or null for initials. Content-addressed: a new picture is a new address. */
export function avatarUrl(hash: string | null | undefined): string | null {
  return hash ? `/api/avatars/${hash}` : null;
}

export type AvatarResult = { ok: true; avatarUrl: string } | { ok: false; error: string; status: 400 | 413 };

/** Delete a picture's bytes unless another account still holds them. Never throws: a stray blob is better than a failed request. */
export async function releaseAvatar(db: Database, hash: string | null, exceptUserId: string): Promise<void> {
  if (!hash) return;
  try {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.avatarKey, hash), ne(users.id, exceptUserId)))
      .limit(1);
    if (!other) await files().remove(avatarKey(hash));
  } catch (err) {
    console.warn(`[avatars] could not delete ${hash.slice(0, 12)}…: ${(err as Error).message}`);
  }
}

export async function setAvatar(db: Database, userId: string, bytes: Buffer): Promise<AvatarResult> {
  if (bytes.byteLength === 0) return { ok: false, error: 'the file is empty', status: 400 };
  if (bytes.byteLength > MAX_AVATAR_BYTES) return { ok: false, error: `a picture is limited to ${MAX_AVATAR_BYTES / 1024} KB`, status: 413 };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, error: 'a picture must be a PNG, JPEG or WebP image', status: 400 };
  const hash = createHash('sha256').update(bytes).digest('hex');
  await files().put(avatarKey(hash), bytes);
  const [before] = await db.select({ key: users.avatarKey }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(users).set({ avatarKey: hash, avatarType: type }).where(eq(users.id, userId));
  if (before?.key && before.key !== hash) await releaseAvatar(db, before.key, userId);
  return { ok: true, avatarUrl: avatarUrl(hash)! };
}

/** Back to initials. Returns whether there was a picture. */
export async function removeAvatar(db: Database, userId: string): Promise<boolean> {
  const [before] = await db.select({ key: users.avatarKey }).from(users).where(eq(users.id, userId)).limit(1);
  if (!before?.key) return false;
  await db.update(users).set({ avatarKey: null, avatarType: null }).where(eq(users.id, userId));
  await releaseAvatar(db, before.key, userId);
  return true;
}

/** A picture a current account holds, or null. */
export async function readAvatar(db: Database, hash: string): Promise<{ bytes: Buffer; type: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const [row] = await db
    .select({ type: users.avatarType })
    .from(users)
    .where(and(eq(users.avatarKey, hash), isNull(users.deletedAt)))
    .limit(1);
  if (!row?.type) return null;
  const bytes = await files().get(avatarKey(hash));
  return bytes ? { bytes, type: row.type } : null;
}

/** The picture's bytes for Download my data (M62), or null. */
export async function avatarForExport(db: Database, userId: string): Promise<{ bytes: Buffer; type: string } | null> {
  const [row] = await db.select({ key: users.avatarKey, type: users.avatarType }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row?.key || !row.type) return null;
  const bytes = await files().get(avatarKey(row.key)).catch(() => null);
  return bytes ? { bytes, type: row.type } : null;
}
