/**
 * Authentication: login sessions, cookies, and the requireUser guard.
 *
 * Login sessions are server-side rows so access can be cut immediately —
 * logout, member removal and password reset all have to take effect now, not
 * whenever a token would have expired. See docs/security.md.
 */
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Database } from '@fabrikka/db';
import { authSessions, generateToken, hashToken, users, verifyPassword } from '@fabrikka/db';

export const COOKIE_NAME = 'fabrikka_session';
const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  ownerSlug: string;
  isInstanceOwner: boolean;
}

/** Hono env so `c.get('user')` is typed on guarded routes. */
export interface AuthEnv {
  Variables: { user: AuthUser };
}

/**
 * Verify credentials and open a login session.
 *
 * Returns null for both "no such user" and "wrong password" — the caller must
 * not distinguish them, or the endpoint becomes an account enumeration oracle.
 */
export async function login(
  db: Database,
  email: string,
  password: string,
): Promise<string | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  // Run verification even when the user is absent so a missing account and a
  // wrong password take indistinguishable time.
  const ok = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !ok) return null;

  return openLoginSession(db, user.id);
}

/**
 * Open a login session for a user already proven to be who they say — by a
 * password above, or by a deployment's own check (the kit's `signIn`, M32).
 * Returns the cookie's token; only its hash is stored.
 */
export async function openLoginSession(db: Database, userId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await db.insert(authSessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return token;
}

export async function logout(db: Database, token: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
}

/** Invalidate every login for a user. Called on password reset. */
export async function logoutAll(db: Database, userId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

/** Resolve the user behind a token, or null if absent, unknown or expired. */
export async function resolveToken(
  db: Database,
  token: string | undefined,
): Promise<AuthUser | null> {
  if (!token) return null;

  const rows = await db
    .select({
      sessionId: authSessions.id,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      ownerSlug: users.ownerSlug,
      isInstanceOwner: users.isInstanceOwner,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(token)),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Fire-and-forget: a failed liveness update must not fail the request.
  void db
    .update(authSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(authSessions.id, row.sessionId))
    .catch(() => {});

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    ownerSlug: row.ownerSlug,
    isInstanceOwner: row.isInstanceOwner,
  };
}

/** Delete expired rows. Cheap enough to call opportunistically. */
export async function pruneExpiredSessions(db: Database): Promise<void> {
  await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()));
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                    */
/* -------------------------------------------------------------------------- */

export function issueCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export function clearCookie(c: Context, secure: boolean): void {
  deleteCookie(c, COOKIE_NAME, { path: '/', secure });
}

export function readCookie(c: Context): string | undefined {
  return getCookie(c, COOKIE_NAME);
}

/* -------------------------------------------------------------------------- */
/* Guard                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Requires a logged-in user and puts them on the context.
 *
 * Returns 401 only for "you are not logged in". Anything about a *specific*
 * session a user may not see is a 404, handled in the route — see
 * docs/security.md.
 */
export function requireUser(db: Database): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = await resolveToken(db, readCookie(c));
    if (!user) return c.json({ error: 'not authenticated' }, 401);
    c.set('user', user);
    await next();
  };
}
