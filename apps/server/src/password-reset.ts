/**
 * Password reset by email (M32, ADR 0029) — offered only when an email
 * transport is configured. Without one, recovery stays the operator's
 * `admin reset-password` (ADR 0007).
 *
 * The link is a bearer credential in an inbox, so: 32 random bytes, only the
 * hash stored, single use, one hour. Using it signs the account out everywhere,
 * exactly as the CLI reset does. See docs/security.md.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { generateToken, hashPassword, hashToken, passwordResets, users } from '@fabrikka/db';
import { logoutAll } from './auth.ts';
import type { Mailer } from './mail.ts';

const LINK_TTL_MS = 60 * 60 * 1000;

/**
 * Email a reset link if the address has an account. Resolves the same either
 * way: the caller must not tell the two apart, or the form becomes a way to
 * find out who is registered.
 */
export async function requestPasswordReset(
  db: Database,
  mailer: Mailer,
  opts: { email: string; publicUrl: string },
): Promise<void> {
  const [user] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.email, opts.email.trim().toLowerCase()))
    .limit(1);
  if (!user) return;

  const token = generateToken();
  await db.insert(passwordResets).values({
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + LINK_TTL_MS),
  });

  await mailer.send({
    to: user.email,
    subject: 'Reset your Fabrikka password',
    text:
      `Hi ${user.displayName},\n\n` +
      `Someone asked to reset the password for this address. If it was you, choose a new one here:\n\n` +
      `${opts.publicUrl}/reset/${token}\n\n` +
      `The link works once, for one hour. Using it signs you out everywhere else.\n` +
      `If it wasn't you, ignore this email: your password stays as it is.\n`,
  });
}

export type CompleteResetResult = { ok: true } | { ok: false; error: string };

/** Set a new password with a link's token, consuming the token. */
export async function completePasswordReset(
  db: Database,
  token: string,
  password: string,
): Promise<CompleteResetResult> {
  // Checked before the token is consumed, so a too-short password doesn't burn the link.
  if (password.length < 8) return { ok: false, error: 'password must be at least 8 characters' };

  // Consuming is one conditional UPDATE: two clicks racing on the same link
  // can't both win.
  const [used] = await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResets.tokenHash, hashToken(token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    )
    .returning({ userId: passwordResets.userId });
  if (!used) return { ok: false, error: 'this link is invalid, already used or expired — ask for a new one' };

  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, used.userId));
  // If the password was reset because it leaked, old cookies must die with it.
  await logoutAll(db, used.userId);
  return { ok: true };
}
