/**
 * Sealing upstream credentials.
 *
 * Unlike a session token, an aggregated server's credential cannot be hashed: the
 * server has to present it upstream, so it must be recoverable. That makes this
 * the first place Fabrikka stores a secret it can decrypt, which is why the
 * failure mode is deliberate — see ADR 0014.
 *
 * AES-256-GCM, random IV per record, auth tag appended. The format carries a
 * version byte so a key rotation or algorithm change can happen in place.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      'FABRIKKA_ENCRYPTION_KEY is not set, so credentials cannot be stored. ' +
        'Generate one with: openssl rand -base64 32',
    );
  }
}

/** Null when unconfigured — callers decide, so the failure is explicit. */
export function encryptionKey(): Buffer | null {
  const raw = process.env.FABRIKKA_ENCRYPTION_KEY;
  if (!raw) return null;

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `FABRIKKA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes base64-encoded, got ${key.length}`,
    );
  }
  return key;
}

export function isEncryptionConfigured(): boolean {
  return encryptionKey() !== null;
}

/**
 * Seal a credential for storage.
 *
 * Throws when no key is configured rather than falling back to plaintext: a
 * deployment that has not thought about key management should not accumulate
 * other people's tokens by accident.
 */
export function seal(plaintext: string): string {
  const key = encryptionKey();
  if (!key) throw new MissingEncryptionKeyError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

/**
 * Open a sealed credential.
 *
 * Returns null on any failure — wrong key, tampering, malformed record — so a
 * corrupt row disables one integration instead of crashing a request. GCM's auth
 * tag means tampering is detected rather than yielding garbage.
 */
export function open(sealed: string | null): string | null {
  if (!sealed) return null;

  const key = encryptionKey();
  if (!key) return null;

  const [version, ivB64, tagB64, dataB64] = sealed.split('.');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
