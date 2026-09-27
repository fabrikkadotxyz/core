/**
 * Password hashing and token handling.
 *
 * Lives in @fabrikka/db because both the HTTP server and the admin CLI need
 * it, and they must not be able to disagree about how a password is stored.
 * Documented in docs/security.md.
 */
import type { ScryptOptions } from 'node:crypto';
import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';

/** promisify() resolves to scrypt's 3-arg overload, losing the options param. */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * scrypt rather than argon2id purely so there is no native module to build: a
 * self-hoster runs `docker compose up` and it works. Parameters sit above
 * OWASP's floor and are encoded in the stored string, so they can be raised
 * later and old hashes upgraded on next login.
 */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64, saltBytes: 32 } as const;

/** scrypt's memory use is roughly 128 * N * r bytes; must exceed the default. */
const MAX_MEMORY = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAX_MEMORY,
  });

  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored value, so a corrupt row denies login instead of 500-ing.
 */
export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * An opaque bearer token. Used for login cookies and invite links.
 *
 * base64url of 32 random bytes: URL-safe, so an invite link needs no escaping,
 * and 256 bits of entropy means it is not guessable.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the hash is ever stored, so reading the database yields nothing usable.
 * SHA-256 without a salt is correct here — the input is already 256 bits of
 * uniform randomness, so there is no dictionary to precompute.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
