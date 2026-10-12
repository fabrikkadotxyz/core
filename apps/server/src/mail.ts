/**
 * Email: one optional transport, never a prerequisite (ADR 0007, 0029).
 *
 * `FABRIKKA_MAIL` picks it: unset or `none` (no email at all — the default),
 * `log` (printed to the server log), `file:<dir>` (one JSON file per message,
 * for development and the acceptance checks), or `smtp://` / `smtps://` (any
 * real provider, ADR 0040, with `FABRIKKA_MAIL_FROM` as the sender).
 *
 * A configured transport is a capability, not a mode: it switches on
 * email-shaped affordances such as "Forgot password?", and nothing else changes.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';

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

  if (value.startsWith('smtp://') || value.startsWith('smtps://')) return smtpMailer(value, process.env.FABRIKKA_MAIL_FROM);

  // A typo must not silently disable password reset on an instance that meant
  // to offer it — fail at startup instead.
  throw new Error(`FABRIKKA_MAIL is "${value}": expected none, log, file:<dir>, smtp:// or smtps:// (docs/operations.md)`);
}

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Any provider, over SMTP (ADR 0040). `smtps://` is TLS from the start;
 * `smtp://` must upgrade with STARTTLS, except to this machine. The URL holds a
 * password, so messages name the host, never the URL.
 */
export function smtpMailer(spec: string, from: string | undefined): Mailer {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    throw new Error('FABRIKKA_MAIL looks like an SMTP URL but is not a valid one (docs/operations.md)');
  }
  if (!url.hostname) throw new Error('FABRIKKA_MAIL has no SMTP host');
  if (!from?.trim()) throw new Error('FABRIKKA_MAIL is SMTP, so FABRIKKA_MAIL_FROM must name the sender, e.g. "Fabrikka <hello@example.com>"');

  const secure = url.protocol === 'smtps:';
  const local = LOCAL.has(url.hostname);
  const host = url.hostname;
  const transport = nodemailer.createTransport({
    host,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    // STARTTLS is required off this machine: never credentials or mail in the clear.
    requireTLS: !secure && !local,
    ignoreTLS: !secure && local,
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  // Checked once at start, never fatal: a provider being down mustn't stop the server.
  transport.verify().then(
    () => console.log(`[mail] SMTP to ${host} is ready`),
    (err: Error) => console.warn(`[mail] SMTP to ${host} failed its check: ${err.message}`),
  );

  return {
    configured: true,
    async send(m) {
      try {
        await transport.sendMail({ from: from.trim(), to: m.to, subject: m.subject, text: m.text });
        return true;
      } catch (err) {
        console.error(`[mail] SMTP to ${host} could not send: ${(err as Error).message}`);
        return false;
      }
    },
  };
}
