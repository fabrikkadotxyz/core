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
import { eq, count } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { teamMembers, teams, users } from '@fabrikka/db';
import type { AuthUser } from '@fabrikka/types';
import { issueCookie, openLoginSession, requireUser, type AuthEnv } from './auth.ts';
import { ensureGeneral } from './chats.ts';
import type { Mailer, EmailMessage } from './mail.ts';
import { clientIp } from './client-ip.ts';
import { membersChanged, register, teamInfo, teamRoleOf, type AccountCheck, type MembersListener, type NoticeProvider, type WriteCheck } from './gates.ts';
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
  /** The client's address, for rate limits: the socket's, or behind FABRIKKA_TRUSTED_PROXIES proxies, the one the outermost saw. */
  clientIp(c: Context): string;
  /** Tell the login page a sign-up page exists. */
  advertise(offer: { signupUrl?: string }): void;

  /* ADR 0041: where a deployment may say no, explain, and listen. */
  /** Before every account the core creates, except the operator's CLI. Null allows; a sentence refuses. */
  guardNewAccounts(check: AccountCheck): void;
  /** Before a write in a room or team. Null allows; `{ reason, url? }` refuses with 402. */
  guardWrites(check: WriteCheck): void;
  /** A short notice on a team, shown above its rooms. */
  teamNotice(provide: NoticeProvider): void;
  /** After a team's membership changed, with its new size. */
  onTeamMembersChanged(listener: MembersListener): void;
  /** A team's basics, or null. */
  team(teamId: string): Promise<{ id: string; name: string; createdAt: Date; createdByUserId: string | null; members: number } | null>;
  /** Someone's role in a team, or null. */
  teamRole(teamId: string, userId: string): Promise<'owner' | 'member' | null>;
  /** How many accounts exist: to refuse early, before guardNewAccounts would. */
  accountCount(): Promise<number>;
  /** The teams someone is on, with their role. */
  teamsOf(userId: string): Promise<{ teamId: string; role: 'owner' | 'member' }[]>;
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
      if (!teamName) return { ok: false, error: 'an organization name is required' };
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
          // M53 (ADR 0051): the account is born with its own organization; this names it as asked.
          const [team] = await tx.update(teams).set({ name: teamName }).where(eq(teams.ownOfUserId, made.user.id)).returning();
          if (!team) throw new KitError('the account has no own organization');
          return { user: made.user, team: { id: team.id, name: team.name } };
        });
        // Every team starts with #general (M29), outside the transaction like createTeam.
        await ensureGeneral(db, created.team.id);
        membersChanged(db, created.team.id);
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
    clientIp,

    advertise(offer) {
      if (offer.signupUrl) opts.advertised.signupUrl = offer.signupUrl;
    },

    guardNewAccounts: register.account,
    guardWrites: register.write,
    teamNotice: register.notice,
    onTeamMembersChanged: register.members,
    team: (teamId) => teamInfo(db, teamId),
    teamRole: (teamId, userId) => teamRoleOf(db, teamId, userId),
    teamsOf: async (userId) =>
      (await db.select({ teamId: teamMembers.teamId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.userId, userId))) as {
        teamId: string;
        role: 'owner' | 'member';
      }[],
    accountCount: async () => {
      const [row] = await db.select({ n: count() }).from(users);
      return Number(row?.n ?? 0);
    },
  };
}

class KitError extends Error {}
