/**
 * Email: one optional transport, never a prerequisite (ADR 0007, 0029).
 *
 * `FABRIKKA_MAIL` picks it: unset or `none` (no email at all — the default),
 * `log` (printed to the server log), or `file:<dir>` (one JSON file per message,
 * for development and the acceptance checks). A transport for a real provider
 * goes behind the same interface.
 *
 * A configured transport is a capability, not a mode: it switches on
 * email-shaped affordances such as "Forgot password?", and nothing else changes.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Every link is written out in full, so it works in any client. */
  text: string;
}

export interface Mailer {
  /** False when no transport is configured; `send` then delivers nothing. */
  readonly configured: boolean;
  /** Resolves false when nothing was sent. Never throws for a delivery failure. */
  send(message: EmailMessage): Promise<boolean>;
}

const none: Mailer = { configured: false, send: async () => false };

export function mailerFromEnv(spec = process.env.FABRIKKA_MAIL): Mailer {
  const value = spec?.trim();
  if (!value || value === 'none') return none;

  if (value === 'log') {
    return {
      configured: true,
      async send(m) {
        console.log(`[mail] to ${m.to} — ${m.subject}\n${m.text}\n[mail] end`);
        return true;
      },
    };
  }

  if (value.startsWith('file:')) {
    const dir = resolve(value.slice('file:'.length));
    return {
      configured: true,
      async send(m) {
        try {
          await mkdir(dir, { recursive: true });
          // Sortable by time, unique within the same millisecond.
          const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
          await writeFile(join(dir, name), JSON.stringify({ ...m, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
          return true;
        } catch (err) {
          console.error('[mail] could not write a message:', (err as Error).message);
          return false;
        }
      },
    };
  }

  // A typo must not silently disable password reset on an instance that meant
  // to offer it — fail at startup instead.
  throw new Error(`FABRIKKA_MAIL is "${value}": expected none, log or file:<dir> (docs/operations.md)`);
}
