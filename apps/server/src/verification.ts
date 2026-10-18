/**
 * A verified address (M64). A link proves that the address on an account, or
 * a new one it wants to move to, reaches its owner. Like a reset link (M32):
 * 32 random bytes, only the hash stored, single use, 24 hours.
 *
 * It matters only where the instance can send email. Without a transport, an
 * account came from an invite the operator or a member sent, and nothing here
 * is required (`verificationRequired`). With one, an unverified account can
 * use the product but not exercise the rights that must reach the right
 * person: export, deletion, an email change. docs/security.md.
 */
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { emailVerifications, generateToken, hashToken, users } from '@fabrikka/db';
import type { Mailer } from './mail.ts';

const LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Whether this instance asks for a proven address at all. */
export function verificationRequired(mailer: Mailer): boolean {
  return mailer.configured;
}

export type SendResult = { ok: true; to: string } | { ok: false; error: string; status: 400 | 404 | 409 | 503 };

/**
 * Send a link for the account's own address, or, with `newEmail`, for the
 * address it wants to move to. The account's address changes only when the
 * link is used; the old address is told at once.
 */
export async function requestVerification(
  db: Database,
  mailer: Mailer,
  opts: { userId: string; publicUrl: string; newEmail?: string },
): Promise<SendResult> {
  if (!mailer.configured) return { ok: false, error: 'this instance cannot send email', status: 503 };
  const [user] = await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, opts.userId)).limit(1);
  if (!user) return { ok: false, error: 'no such account', status: 404 };
  const to = (opts.newEmail ?? user.email).trim().toLowerCase();
  if (!to.includes('@')) return { ok: false, error: 'invalid email address', status: 400 };
  if (opts.newEmail) {
    if (to === user.email) return { ok: false, error: 'that is already your address', status: 400 };
    const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, to), ne(users.id, user.id))).limit(1);
    // Said plainly: the person is signed in and proved their password to ask.
    if (taken) return { ok: false, error: 'that email is already registered', status: 409 };
  }
  const token = generateToken();
  await db.insert(emailVerifications).values({ tokenHash: hashToken(token), userId: user.id, email: to, expiresAt: new Date(Date.now() + LINK_TTL_MS) });
  const link = `${opts.publicUrl}/verify/${token}`;
  if (opts.newEmail) {
    await mailer.send({
      to,
      subject: 'Confirm your new Fabrikka address',
      text:
        `Hi ${user.displayName},\n\n` +
        `You asked to move your Fabrikka account to this address. Confirm it here:\n\n${link}\n\n` +
        `The link works once, for 24 hours. Until you use it, your account stays on ${user.email}.\n` +
        `If it wasn't you, ignore this email.\n`,
    });
    await mailer.send({
      to: user.email,
      subject: 'Your Fabrikka address is being changed',
      text:
        `Hi ${user.displayName},\n\n` +
        `Someone signed in to your Fabrikka account and asked to move it to ${to}. ` +
        `Nothing changes until the link sent there is used.\n\n` +
        `If this wasn't you, sign in now and change your password: that ends every other session.\n`,
    });
  } else {
    await mailer.send({
      to,
      subject: 'Confirm your Fabrikka address',
      text:
        `Hi ${user.displayName},\n\n` +
        `Confirm that this address is yours:\n\n${link}\n\n` +
        `The link works once, for 24 hours. Until then you can use Fabrikka as usual, but not download or delete your account, or change its address.\n`,
    });
  }
  return { ok: true, to };
}

export type CompleteResult = { ok: true; userId: string; email: string; changedFrom: string | null } | { ok: false; error: string };

/** Use a link: mark the address verified, moving the account to it if it was a change. */
export async function completeVerification(db: Database, token: string): Promise<CompleteResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ tokenHash: emailVerifications.tokenHash, userId: emailVerifications.userId, email: emailVerifications.email })
      .from(emailVerifications)
      .where(and(eq(emailVerifications.tokenHash, hashToken(token)), isNull(emailVerifications.usedAt), gt(emailVerifications.expiresAt, new Date())))
      .limit(1);
    if (!row) return { ok: false, error: 'this link is not valid any more: ask for a new one' };
    const [user] = await tx.select({ email: users.email, deletedAt: users.deletedAt }).from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user || user.deletedAt) return { ok: false, error: 'this link is not valid any more: ask for a new one' };
    if (row.email !== user.email) {
      const [taken] = await tx.select({ id: users.id }).from(users).where(and(eq(users.email, row.email), ne(users.id, row.userId))).limit(1);
      if (taken) return { ok: false, error: 'that email is already registered' };
    }
    await tx.update(users).set({ email: row.email, emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
    await tx.update(emailVerifications).set({ usedAt: new Date() }).where(eq(emailVerifications.tokenHash, row.tokenHash));
    return { ok: true, userId: row.userId, email: row.email, changedFrom: row.email !== user.email ? user.email : null };
  });
}
