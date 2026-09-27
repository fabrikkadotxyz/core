/**
 * User creation and management.
 *
 * Shared by the HTTP signup route and the admin CLI so the two cannot disagree
 * about how an account is made. See docs/operations.md.
 */
import { asc, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { hashPassword, users } from '@fabrikka/db';
import type { AuthUser } from '@fabrikka/types';
import { logoutAll } from './auth.ts';

export type CreateUserResult =
  | { ok: true; user: AuthUser }
  | { ok: false; error: string };

export async function createUser(
  db: Database,
  input: {
    email: string;
    password: string;
    displayName: string;
    isInstanceOwner?: boolean;
  },
): Promise<CreateUserResult> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();

  if (!email.includes('@')) return { ok: false, error: 'invalid email address' };
  if (!displayName) return { ok: false, error: 'display name is required' };
  if (input.password.length < 8) {
    return { ok: false, error: 'password must be at least 8 characters' };
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) return { ok: false, error: 'that email is already registered' };

  const [row] = await db
    .insert(users)
    .values({
      email,
      ownerSlug: await freeOwnerSlug(db, displayName, email),
      passwordHash: await hashPassword(input.password),
      displayName,
      isInstanceOwner: input.isInstanceOwner ?? false,
    })
    .returning();

  return {
    ok: true,
    user: {
      id: row!.id,
      email: row!.email,
      displayName: row!.displayName,
      ownerSlug: row!.ownerSlug,
      isInstanceOwner: row!.isInstanceOwner,
    },
  };
}

/**
 * Set a new password and invalidate every existing login.
 *
 * This is the password recovery path — there is no emailed reset link
 * (ADR 0007). Cutting existing sessions is the point: if a password was reset
 * because it may be compromised, leaving old cookies valid defeats the reset.
 */
export async function resetPassword(
  db: Database,
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (password.length < 8) {
    return { ok: false, error: 'password must be at least 8 characters' };
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user) return { ok: false, error: 'no such user' };

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, user.id));

  await logoutAll(db, user.id);
  return { ok: true };
}

export async function listUsers(db: Database) {
  return db
    .select({
      email: users.email,
      displayName: users.displayName,
      ownerSlug: users.ownerSlug,
      isInstanceOwner: users.isInstanceOwner,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt));
}

export async function deleteUser(
  db: Database,
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deleted = await db
    .delete(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ id: users.id });

  return deleted.length > 0 ? { ok: true } : { ok: false, error: 'no such user' };
}

export async function countUsers(db: Database): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

/**
 * The owner slug is public and appears in MCP endpoint URLs, so it must be
 * URL-safe and stable. Derived from the display name, falling back to the email
 * local part, suffixed on collision.
 */
async function freeOwnerSlug(
  db: Database,
  displayName: string,
  email: string,
): Promise<string> {
  const base =
    slugify(displayName) || slugify(email.split('@')[0] ?? '') || 'user';

  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.ownerSlug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
