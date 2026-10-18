/**
 * M59 acceptance: sign-in that resists guessing.
 *
 * Against the server: a throwaway account fails ten sign-ins; the eleventh
 * attempt with the RIGHT password is refused with the very same status, body
 * and headers as a wrong one; a different account from the same client still
 * signs in. From the source: failures count and successes don't, and the
 * signup and redeem routes carry their brakes. The window itself is covered
 * by the unit test, which moves the clock.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) and the test
 * account. Never fails a sign-in of the test account itself.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CORE = process.env.FABRIKKA_CORE ?? 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const read = (p) => readFileSync(p, 'utf8');
async function req(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(`${CORE}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  const headers = [...r.headers.keys()].filter((h) => !['date', 'content-length', 'connection', 'keep-alive'].includes(h)).sort().join(',');
  return { status: r.status, json, text, cookie: set ? set.split(';')[0] : undefined, headers };
}

/* ------------------------------------------------ 1. the source */

const th = read('apps/server/src/login-throttle.ts');
check(/LOGIN_MAX_PER_EMAIL = 10/.test(th) && /LOGIN_MAX_PER_CLIENT = 100/.test(th) && /LOGIN_WINDOW_MS = 15 \* 60 \* 1000/.test(th), 'TEN PER ADDRESS, A HUNDRED PER CLIENT, FIFTEEN MINUTES');
const allowedBody = th.match(/allowed\(email, ip\) \{([\s\S]*?)return true;\s*\}/)?.[1] ?? 'bump(';
check(!/bump\(/.test(allowedBody) && /failed\(email, ip\) \{\s*bump\(keyEmail\(email\)\);\s*bump\(keyIp\(ip\)\);/.test(th), 'checking never counts: only failed() does');
const app = read('apps/server/src/app.ts');
check(/if \(!loginThrottle\.allowed\(email, ip\)\) \{[\s\S]{0,300}return c\.json\(\{ error: 'invalid email or password' \}, 401\);/.test(app), 'A LOCKED ATTEMPT ANSWERS EXACTLY LIKE A WRONG PASSWORD');
check(/if \(!signedIn\) \{\s*loginThrottle\.failed\(email, ip\);/.test(app), 'a failed sign-in counts');
check(/rateLimit\(`signup:ip:\$\{clientIp\(c\)\}`, \{ max: 300, windowMs: 15 \* 60_000 \}\)/.test(app), 'sign-up has its brake per client…');
check(/rateLimit\(`redeem:user:\$\{c\.get\('user'\)\.id\}`, \{ max: 300, windowMs: 15 \* 60_000 \}\)/.test(app), '…and redeeming an invite per account');
check(/### Guessing passwords \(M59\)/.test(read('docs/security.md')), 'the trust model says so');

/* ------------------------------------------------ 2. the server */

const alice = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
check(!!alice, 'the test account signs in');
const stamp = Date.now();
const seed = (await req('/sessions', { method: 'POST', body: { title: `M59 seed ${stamp}`, visibility: 'private' }, cookie: alice })).json;
const inv = (await req(`/o/${seed.ownerSlug}/s/${seed.publicId}/invites`, { method: 'POST', body: {}, cookie: alice })).json;
const victimEmail = `m59-victim-${stamp}@example.com`;
const made = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: victimEmail, password: 'password123', displayName: `Victim${stamp}` } });
check(made.status === 201, 'a throwaway account exists');

const wrong = await req('/auth/login', { method: 'POST', body: { email: victimEmail, password: 'nope-1' } });
check(wrong.status === 401 && wrong.json.error === 'invalid email or password', 'a wrong password: invalid email or password');
for (let i = 2; i <= 10; i++) await req('/auth/login', { method: 'POST', body: { email: victimEmail, password: `nope-${i}` } });
const locked = await req('/auth/login', { method: 'POST', body: { email: victimEmail, password: 'password123' } });
check(locked.status === 401, 'AFTER TEN FAILURES THE RIGHT PASSWORD IS REFUSED');
check(locked.text === wrong.text, '…with the identical body');
check(locked.headers === wrong.headers && !locked.cookie, '…and the identical headers, no cookie');
const upper = await req('/auth/login', { method: 'POST', body: { email: victimEmail.toUpperCase(), password: 'password123' } });
check(upper.status === 401, 'the address is locked in any letter case');
check((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).status === 200, 'ANOTHER ACCOUNT FROM THE SAME CLIENT STILL SIGNS IN');

// Tidy: the throwaway account and the seed room. (The lock itself passes in 15 minutes.)
execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', victimEmail, '--now', '--yes'], { stdio: 'ignore' });
await req(`/o/${seed.ownerSlug}/s/${seed.publicId}`, { method: 'DELETE', cookie: alice });

console.log(failures ? `\n${failures} FAILED` : '\nM59 checks passed');
process.exit(failures ? 1 : 0);
