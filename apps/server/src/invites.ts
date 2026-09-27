/**
 * Session invites.
 *
 * An invite is a durable record plus a token link — never a message. This is
 * what lets Fabrikka run with no mail server at all: the system generates a
 * link, a human delivers it however they like. See ADR 0007.
 *
 * Single-use, expiring, revocable, hashed at rest, and optionally scoped to an
 * email address. The scope is enforced here at redemption, which is why it needs
 * no delivery mechanism to be meaningful.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  generateToken,
  hashToken,
  sessionInvites,
  sessions as sessionsPublicId,
  users,
} from '@fabrikka/db';
import type { InviteSummary } from '@fabrikka/types';
import { addMember, type SessionRole } from './sessions.ts';

const DEFAULT_TTL_DAYS = 7;

export interface CreatedInvite {
  summary: InviteSummary;
  /** Plaintext token. Returned exactly once and never recoverable. */
  token: string;
}

export async function createInvite(
  db: Database,
  opts: {
    sessionId: string;
    createdByUserId: string;
    role?: SessionRole;
    /** Optional scope: only this address may redeem. Nothing is sent to it. */
    invitedEmail?: string | null;
    ttlDays?: number;
  },
): Promise<CreatedInvite> {
  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000,
  );

  const [row] = await db
    .insert(sessionInvites)
    .values({
      sessionId: opts.sessionId,
      tokenHash: hashToken(token),
      role: opts.role ?? 'member',
      invitedEmail: opts.invitedEmail?.trim().toLowerCase() || null,
      createdByUserId: opts.createdByUserId,
      expiresAt,
    })
    .returning();

  return { token, summary: toSummary(row!) };
}

export async function listInvites(
  db: Database,
  sessionId: string,
): Promise<InviteSummary[]> {
  const rows = await db
    .select()
    .from(sessionInvites)
    .where(eq(sessionInvites.sessionId, sessionId))
    .orderBy(desc(sessionInvites.createdAt));

  return rows.map(toSummary);
}

/** Revoking is idempotent and only affects unredeemed invites. */
export async function revokeInvite(
  db: Database,
  sessionId: string,
  inviteId: string,
): Promise<boolean> {
  const updated = await db
    .update(sessionInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessionInvites.id, inviteId),
        eq(sessionInvites.sessionId, sessionId),
        isNull(sessionInvites.redeemedAt),
        isNull(sessionInvites.revokedAt),
      ),
    )
    .returning({ id: sessionInvites.id });

  return updated.length > 0;
}

export type RedeemFailure =
  | 'not_found'
  | 'already_redeemed'
  | 'revoked'
  | 'expired'
  | 'wrong_email';

export type RedeemResult =
  | { ok: true; sessionPublicId: string; ownerSlug: string }
  | { ok: false; reason: RedeemFailure };

/**
 * Redeem an invite for a logged-in user.
 *
 * The claim is made under a transaction with a conditional update, so two
 * simultaneous redemptions cannot both succeed — single-use has to hold under
 * concurrency, not just in the happy path.
 */
export async function redeemInvite(
  db: Database,
  token: string,
  user: { id: string; email: string; displayName: string },
): Promise<RedeemResult> {
  const tokenHash = hashToken(token);

  const claimed = await db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(sessionInvites)
      .where(eq(sessionInvites.tokenHash, tokenHash))
      .limit(1);

    if (!invite) return { ok: false as const, reason: 'not_found' as const };
    if (invite.revokedAt) return { ok: false as const, reason: 'revoked' as const };
    if (invite.redeemedAt) {
      return { ok: false as const, reason: 'already_redeemed' as const };
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      return { ok: false as const, reason: 'expired' as const };
    }
    if (
      invite.invitedEmail &&
      invite.invitedEmail !== user.email.trim().toLowerCase()
    ) {
      return { ok: false as const, reason: 'wrong_email' as const };
    }

    // Conditional update is the actual single-use guarantee: whoever's UPDATE
    // matches the still-unredeemed row wins, and the loser sees zero rows.
    const won = await tx
      .update(sessionInvites)
      .set({ redeemedAt: new Date(), redeemedByUserId: user.id })
      .where(
        and(
          eq(sessionInvites.id, invite.id),
          isNull(sessionInvites.redeemedAt),
          isNull(sessionInvites.revokedAt),
        ),
      )
      .returning({ sessionId: sessionInvites.sessionId, role: sessionInvites.role });

    if (won.length === 0) {
      return { ok: false as const, reason: 'already_redeemed' as const };
    }

    return {
      ok: true as const,
      sessionId: won[0]!.sessionId,
      role: won[0]!.role as SessionRole,
    };
  });

  if (!claimed.ok) return claimed;

  await addMember(db, claimed.sessionId, user, claimed.role);

  const [row] = await db
    .select({
      publicId: sessionsPublicId.publicId,
      ownerSlug: users.ownerSlug,
    })
    .from(sessionsPublicId)
    .innerJoin(users, eq(users.id, sessionsPublicId.ownerId))
    .where(eq(sessionsPublicId.id, claimed.sessionId))
    .limit(1);

  return {
    ok: true,
    sessionPublicId: row!.publicId,
    ownerSlug: row!.ownerSlug,
  };
}

/** Public, non-secret description of an invite, for a pre-redemption preview. */
export async function describeInvite(
  db: Database,
  token: string,
): Promise<{ sessionTitle: string; invitedEmail: string | null } | null> {
  const [row] = await db
    .select({
      title: sessionsPublicId.title,
      invitedEmail: sessionInvites.invitedEmail,
      redeemedAt: sessionInvites.redeemedAt,
      revokedAt: sessionInvites.revokedAt,
      expiresAt: sessionInvites.expiresAt,
    })
    .from(sessionInvites)
    .innerJoin(
      sessionsPublicId,
      eq(sessionsPublicId.id, sessionInvites.sessionId),
    )
    .where(eq(sessionInvites.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.redeemedAt || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return { sessionTitle: row.title, invitedEmail: row.invitedEmail };
}

function toSummary(row: typeof sessionInvites.$inferSelect): InviteSummary {
  return {
    id: row.id,
    role: row.role as SessionRole,
    invitedEmail: row.invitedEmail,
    expiresAt: row.expiresAt.toISOString(),
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
