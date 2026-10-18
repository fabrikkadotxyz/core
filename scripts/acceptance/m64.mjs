/**
 * M64 acceptance: a verified address.
 *
 * Spawns the core on a spare port with FABRIKKA_MAIL=file:<dir>, so emails are
 * files. A sign-up through a link gets a confirmation email; export and
 * deletion are refused with `verify: true` until the link is used, then export
 * works; a change of address sends a link to the new address and a notice to
 * the old, changes nothing until the link is used, then changes the address
 * and tells the old one; a used link is refused; the trail has the events.
 * On the running core with no transport (FABRIKKA_CORE), nothing is required.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090), the test account,
 * and a free port for the mail-enabled core (M64_PORT, default 9464).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = process.env.FABRIKKA_CORE ?? 'http://localhost:9090';
const PORT = Number(process.env.M64_PORT ?? 9464);
const MAILED = `http://localhost:${PORT}`;
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
async function req(origin, path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  return { status: r.status, json, text, cookie: set ? set.split(';')[0] : undefined };
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------ 1. the source */

const ver = read('apps/server/src/verification.ts');
check(/return mailer\.configured;/.test(ver), 'WITHOUT A TRANSPORT NOTHING IS REQUIRED');
check(/LINK_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(ver) && /hashToken\(token\)/.test(ver) && /isNull\(emailVerifications\.usedAt\)/.test(ver), 'a link: 24 hours, hash stored, once');
const app = read('apps/server/src/app.ts');
check((app.match(/verificationRequired\(mailer\) && !me\.emailVerified\) return c\.json\(\{ error: [^}]*verify: true \}, 403\)/g) ?? []).length === 3, 'EXPORT, DELETION AND AN ADDRESS CHANGE ARE GATED, nothing else');
check(/emailVerified: true,\s*\/\/ The operator's own command/.test(read('apps/server/src/cli.ts')), "the operator's create-user vouches for the address");
check(/<Route path="\/verify\/:token" element=\{<VerifyPage \/>\} \/>/.test(read('apps/web/src/App.tsx')) && /Change my email…/.test(read('apps/web/src/pages/AccountPage.tsx')), 'the verify page and the account section exist');

/* ------------------------------------------------ 2. the core with no transport */

const options = await req(CORE, '/auth/options');
check(options.json?.verifiesEmail === false, 'the core with no FABRIKKA_MAIL verifies nothing…');
check((await req(CORE, '/me/verification', { method: 'POST', cookie: (await req(CORE, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie })).status !== 403, '…and asks for no confirmation');

/* ------------------------------------------------ 3. a core that sends email */

const mailDir = mkdtempSync(join(tmpdir(), 'm64-mail-'));
const server = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', 'src/index.ts'], {
  cwd: 'apps/server',
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: MAILED, FABRIKKA_MAIL: `file:${mailDir}`, FABRIKKA_BACKUP_DIR: '' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));
for (let i = 0; i < 120; i++) {
  if ((await fetch(`${MAILED}/health`).catch(() => null))?.ok) break;
  await settle(500);
}
const mails = () => readdirSync(mailDir).sort().map((f) => JSON.parse(readFileSync(join(mailDir, f), 'utf8')));
const linkIn = (m) => m?.text.match(/\/verify\/([A-Za-z0-9_-]+)/)?.[1];

try {
  check((await req(MAILED, '/auth/options')).json?.verifiesEmail === true, 'WITH A TRANSPORT, the instance verifies addresses');
  const alice = (await req(MAILED, '/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
  const stamp = Date.now();
  const seed = (await req(MAILED, '/sessions', { method: 'POST', body: { title: `M64 seed ${stamp}`, visibility: 'private' }, cookie: alice })).json;
  const inv = (await req(MAILED, `/o/${seed.ownerSlug}/s/${seed.publicId}/invites`, { method: 'POST', body: {}, cookie: alice })).json;
  const patEmail = `m64-pat-${stamp}@example.com`;
  const pat = await req(MAILED, '/auth/signup', { method: 'POST', body: { token: inv.token, email: patEmail, password: 'password123', displayName: `Pat${stamp}` } });
  check(pat.status === 201 && pat.json.user.emailVerified === false, 'Pat signs up through a link: not yet confirmed');
  await settle();
  const first = mails().find((m) => m.to === patEmail);
  check(first && /Confirm your Fabrikka address/.test(first.subject) && linkIn(first), 'A CONFIRMATION EMAIL WENT OUT, with a link');

  const refusedExport = await req(MAILED, '/me/export', { method: 'POST', body: { password: 'password123' }, cookie: pat.cookie });
  check(refusedExport.status === 403 && refusedExport.json.verify === true, 'UNCONFIRMED: the export is refused, and says to confirm');
  const refusedDeletion = await req(MAILED, '/me/deletion', { method: 'POST', body: { password: 'password123', eraseName: false }, cookie: pat.cookie });
  check(refusedDeletion.status === 403 && refusedDeletion.json.verify === true, '…so is deletion');
  check((await req(MAILED, '/me/email', { method: 'POST', body: { email: `x-${stamp}@example.com`, password: 'password123' }, cookie: pat.cookie })).status === 403, '…and an address change');
  check((await req(MAILED, `/o/${seed.ownerSlug}/s/${seed.publicId}/messages`, { method: 'POST', body: { content: 'still works' }, cookie: pat.cookie })).status === 201, 'but Pat can use the product');

  const used = await req(MAILED, '/auth/verify', { method: 'POST', body: { token: linkIn(first) } });
  check(used.status === 200 && used.json.email === patEmail && used.json.changed === false, 'THE LINK CONFIRMS THE ADDRESS');
  check((await req(MAILED, '/auth/verify', { method: 'POST', body: { token: linkIn(first) } })).status === 400, 'a used link is refused');
  check((await req(MAILED, '/auth/me', { cookie: pat.cookie })).json.user.emailVerified === true, 'the session sees it at once');
  check((await req(MAILED, '/me/export', { method: 'POST', body: { password: 'password123' }, cookie: pat.cookie })).status === 200, 'and the export works');

  const newEmail = `m64-pat-new-${stamp}@example.com`;
  check((await req(MAILED, '/me/email', { method: 'POST', body: { email: newEmail, password: 'wrong' }, cookie: pat.cookie })).status === 401, 'changing the address needs the password');
  const asked = await req(MAILED, '/me/email', { method: 'POST', body: { email: newEmail, password: 'password123' }, cookie: pat.cookie });
  check(asked.status === 200 && asked.json.to === newEmail, 'Pat asks to move to a new address');
  await settle();
  const toNew = mails().find((m) => m.to === newEmail);
  const toOld = mails().find((m) => m.to === patEmail && /being changed/.test(m.subject));
  check(toNew && linkIn(toNew) && toOld, 'A LINK TO THE NEW ADDRESS, A NOTICE TO THE OLD');
  check((await req(MAILED, '/auth/me', { cookie: pat.cookie })).json.user.email === patEmail, 'nothing changes until the link is used');
  const moved = await req(MAILED, '/auth/verify', { method: 'POST', body: { token: linkIn(toNew) } });
  check(moved.status === 200 && moved.json.changed === true && moved.json.email === newEmail, 'THE LINK MOVES THE ACCOUNT');
  await settle();
  check((await req(MAILED, '/auth/me', { cookie: pat.cookie })).json.user.email === newEmail, 'the account is on the new address');
  check((await req(MAILED, '/auth/login', { method: 'POST', body: { email: newEmail, password: 'password123' } })).status === 200 && (await req(MAILED, '/auth/login', { method: 'POST', body: { email: patEmail, password: 'password123' } })).status === 401, 'sign-in works with the new address and not the old');
  check(mails().some((m) => m.to === patEmail && /has changed/.test(m.subject)), 'and the old address was told');
  const mine = (await req(MAILED, '/me/audit', { cookie: pat.cookie })).json.events.map((e) => e.action);
  check(['email.verification_sent', 'email.verified', 'email.change_requested', 'email.changed'].every((a) => mine.includes(a)), 'THE TRAIL has all four email events');

  // Tidy.
  execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', newEmail, '--now', '--yes'], { stdio: 'ignore' });
  await req(MAILED, `/o/${seed.ownerSlug}/s/${seed.publicId}`, { method: 'DELETE', cookie: alice });
} finally {
  server.kill();
  rmSync(mailDir, { recursive: true, force: true });
  if (failures && serverErr) console.error(serverErr.split('\n').slice(-10).join('\n'));
}

console.log(failures ? `\n${failures} FAILED` : '\nM64 checks passed');
process.exit(failures ? 1 : 0);
