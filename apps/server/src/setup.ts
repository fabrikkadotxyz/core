/**
 * The first owner, created in the browser (M39, ADR 0035).
 *
 * While an instance has no users, `/setup` creates the instance owner, but only
 * with the setup code: `FABRIKKA_SETUP_CODE` when the deployment sets one,
 * otherwise a code generated at start and printed in the server log, which only
 * whoever runs the server can read. Once any user exists, setup is gone.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { users } from '@fabrikka/db';
import { createUser } from './users.ts';

/** Crockford base32: no I, L, O or U, so a code read off a log can't be mistyped into another. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Any fixed number: the advisory lock that makes "no users yet" and "create the owner" one step. */
const SETUP_LOCK = 39_035;

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 429,
  ) {
    super(message);
  }
}

/** 20 characters (100 bits), shown in groups of five. */
export function generateSetupCode(): string {
  const bytes = randomBytes(20);
  let code = '';
  for (const b of bytes) code += ALPHABET[b % 32];
  return code.match(/.{5}/g)!.join('-');
}

/** What a person might type: any case, with or without the dashes and spaces. */
const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

export async function hasUsers(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return !!row;
}

export interface Setup {
  /** Called once at start: picks the code and, when it was generated, prints it. */
  prepare(): Promise<void>;
  needed(): Promise<boolean>;
  createOwner(input: { code: string; email: string; displayName: string; password: string }): Promise<{ email: string }>;
}

export function createSetup(db: Database, configured = process.env.FABRIKKA_SETUP_CODE): Setup {
  let code: string | null = configured?.trim() ? configured.trim() : null;
  let failures = 0;
  let lockedUntil = 0;

  return {
    async prepare() {
      if (await hasUsers(db)) return;
      if (!code) code = generateSetupCode();
      const where = configured?.trim() ? 'the FABRIKKA_SETUP_CODE you configured' : code;
      console.log(
        [
          '',
          '  ┌─────────────────────────────────────────────────────────┐',
          '  │  Fabrikka isn\'t set up yet. Open it in a browser and   │',
          '  │  create the owner with this setup code:                 │',
          `  │      ${where.padEnd(51)}│`,
          '  └─────────────────────────────────────────────────────────┘',
          '',
        ].join('\n'),
      );
    },

    async needed() {
      return !(await hasUsers(db));
    },

    async createOwner(input) {
      if (Date.now() < lockedUntil) throw new SetupError('too many wrong setup codes; try again in a few minutes', 429);
      if (!code) throw new SetupError('not found', 404);

      const given = Buffer.from(normalize(input.code ?? ''));
      const expected = Buffer.from(normalize(code));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        failures += 1;
        if (failures >= MAX_FAILURES) {
          failures = 0;
          lockedUntil = Date.now() + LOCKOUT_MS;
          console.warn('[setup] 10 wrong setup codes: setup refused for 15 minutes');
        }
        throw new SetupError('that setup code is not right', 403);
      }

      // "Nobody exists yet" and "create the owner" in one transaction, under a lock,
      // so two requests with the right code can't both make an owner.
      const created = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
        const [someone] = await tx.select({ id: users.id }).from(users).limit(1);
        if (someone) return null;
        return createUser(tx as unknown as Database, {
          email: input.email ?? '',
          displayName: input.displayName ?? '',
          password: input.password ?? '',
          isInstanceOwner: true,
        });
      });
      if (!created) throw new SetupError('not found', 404);
      if (!created.ok) throw new SetupError(created.error, 400);

      code = null; // spent: setup is over
      failures = 0;
      console.log(`[setup] instance owner created: ${created.user.email}`);
      return { email: created.user.email };
    },
  };
}
