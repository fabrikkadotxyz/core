/**
 * The kit: what a deployment's extension may use (M32, ADR 0029).
 *
 * This is the open core's library contract — documented in docs/protocol.md
 * ("Extending the server") and kept stable. Everything else in the core is
 * internal. A deployment's sign-up can be built on this and nothing more.
 *
 * The one rule the kit enforces by its shape: it can create an account only
 * together with a brand-new team that account owns. There is no kit function
 * that puts anyone into an existing team or session — that stays the invite's
 * job. In-process code is trusted; the kit is a contract, not a sandbox.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { teamMembers, teams, users } from '@fabrikka/db';
import type { AuthUser } from '@fabrikka/types';
import { issueCookie, openLoginSession, requireUser, type AuthEnv } from './auth.ts';
import { ensureGeneral } from './chats.ts';
import type { Mailer, EmailMessage } from './mail.ts';
import { rateLimit } from './rate-limit.ts';
import { createUser } from './users.ts';

const MAX_TEAM_NAME = 80;

export interface Extension {
  /** Names its routes: `/api/<name>/…` by convention. */
  name: string;
  /** Called once, before the core's own routes and the web app's catch-all. */
  mount(app: Hono<AuthEnv>, kit: Kit): void;
}

export type NewAccountResult =
  | { ok: true; user: AuthUser; team: { id: string; name: string } }
  | { ok: false; error: string };

export interface Kit {
  db: Database;
  publicUrl: string;
  requireUser: MiddlewareHandler<AuthEnv>;
  findUserByEmail(email: string): Promise<{ id: string; email: string; displayName: string } | null>;
  /** A new user and a new team they own, in one transaction. The only way the kit creates an account. */
  createAccountWithOwnTeam(input: {
    email: string;
    password: string;
    displayName: string;
    teamName: string;
    /** True only when the deployment verified the address first. */
    emailVerified: boolean;
  }): Promise<NewAccountResult>;
  /** Start a login session and set the cookie, as /api/auth/login does. */
  signIn(c: Context, userId: string): Promise<void>;
  sendEmail(message: EmailMessage): Promise<boolean>;
  readonly canSendEmail: boolean;
  rateLimit(key: string, opts: { max: number; windowMs: number }): boolean;
  /** Tell the login page a sign-up page exists. */
  advertise(offer: { signupUrl?: string }): void;
}

/** What extensions advertised, for GET /api/auth/options. */
export interface Advertised {
  signupUrl: string | null;
}

export function createKit(opts: {
  db: Database;
  publicUrl: string;
  secureCookies: boolean;
  mailer: Mailer;
  advertised: Advertised;
}): Kit {
  const { db } = opts;
  return {
    db,
    publicUrl: opts.publicUrl,
    requireUser: requireUser(db),

    async findUserByEmail(email) {
      const [row] = await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()))
        .limit(1);
      return row ?? null;
    },

    async createAccountWithOwnTeam(input) {
      const teamName = input.teamName.trim().slice(0, MAX_TEAM_NAME);
      if (!teamName) return { ok: false, error: 'a team name is required' };
      try {
        const created = await db.transaction(async (tx) => {
          // createUser runs its own checks (email shape, length, taken). Same
          // function as the CLI and the invite sign-up, so they can't disagree.
          const made = await createUser(tx as unknown as Database, {
            email: input.email,
            password: input.password,
            displayName: input.displayName,
            emailVerified: input.emailVerified,
          });
          if (!made.ok) throw new KitError(made.error);
          const [team] = await tx.insert(teams).values({ name: teamName, createdByUserId: made.user.id }).returning();
          await tx.insert(teamMembers).values({ teamId: team!.id, userId: made.user.id, role: 'owner' });
          return { user: made.user, team: { id: team!.id, name: team!.name } };
        });
        // Every team starts with #general (M29), outside the transaction like createTeam.
        await ensureGeneral(db, created.team.id);
        return { ok: true, ...created };
      } catch (err) {
        if (err instanceof KitError) return { ok: false, error: err.message };
        // Two sign-ups racing for one address: the unique index is the referee.
        if ((err as { code?: string }).code === '23505') return { ok: false, error: 'that email is already registered' };
        throw err;
      }
    },

    async signIn(c, userId) {
      issueCookie(c, await openLoginSession(db, userId), opts.secureCookies);
    },

    sendEmail: (message) => opts.mailer.send(message),
    get canSendEmail() {
      return opts.mailer.configured;
    },
    rateLimit,

    advertise(offer) {
      if (offer.signupUrl) opts.advertised.signupUrl = offer.signupUrl;
    },
  };
}

class KitError extends Error {}
