/**
 * M32 acceptance: the core as a library, email, and password reset by email
 * (ADR 0029).
 *
 * Two servers. The core's own on :9090, which must offer nothing new. And a test
 * deployment — `createApp` plus a fixture extension, with FABRIKKA_MAIL writing
 * messages to a folder — started here on its own port, the way the hosted
 * version runs. Reset links are read from those message files, so the whole
 * email flow is exercised with no provider.
 *
 * Requires: the core server on :9090, Docker's Postgres (fabrikka-postgres).
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = 'http://localhost:9090';
const PORT = 9195;
const DEP = `http://localhost:${PORT}`;
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

function jar() {
  let cookie = '';
  return {
    get headers() {
      return cookie ? { cookie } : {};
    },
    capture(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        if (pair?.startsWith('fabrikka_session=')) cookie = pair;
      }
    },
  };
}

async function req(base, path, { method = 'GET', body, jar: j } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(j?.headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  j?.capture(res);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const run = (cmd, args, stdin = '') =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out)));
    child.stdin.end(stdin);
  });
const admin = (args, stdin) => run('pnpm', ['admin', ...args], stdin);
const sql = (q) => run('docker', ['exec', '-i', 'fabrikka-postgres', 'psql', '-U', 'fabrikka', '-d', 'fabrikka', '-tAc', q]);

/* --------------------------------------------- the test deployment */

const mailDir = mkdtempSync(join(tmpdir(), 'm32-mail-'));
const deployment = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', '../../scripts/fixtures/extension-server.mts'], {
  cwd: 'apps/server',
  // As if behind one proxy, like Render or Caddy (operations.md, "Behind a proxy").
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: DEP, FABRIKKA_MAIL: `file:${mailDir}`, FABRIKKA_TRUSTED_PROXIES: '1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
for (let i = 0; i < 60; i++) {
  if ((await fetch(`${DEP}/health`).catch(() => null))?.ok) break;
  await new Promise((r) => setTimeout(r, 500));
}

const mails = () => readdirSync(mailDir).sort().map((f) => JSON.parse(readFileSync(join(mailDir, f), 'utf8')));
const linkIn = (m) => m.text.match(/\/reset\/([A-Za-z0-9_-]+)/)?.[1];
const stamp = Date.now();
const created = [];

/* ----------------------------- 1. the core alone offers nothing new */

const coreOptions = await req(CORE, '/api/auth/options');
check(coreOptions.json?.passwordReset === false && coreOptions.json?.signupUrl === null, 'with no FABRIKKA_MAIL, the login page is offered no reset and no sign-up');
check((await req(CORE, '/api/auth/password-reset', { method: 'POST', body: { email: EMAIL } })).status === 404, 'asking the core for a reset link is refused');
const cliEmail = `cli-m32-${stamp}@example.com`;
created.push(cliEmail);
await admin(['create-user', '--email', cliEmail, '--password-stdin'], 'first-password');
await admin(['reset-password', '--email', cliEmail, '--password-stdin'], 'second-password');
check((await req(CORE, '/api/auth/login', { method: 'POST', body: { email: cliEmail, password: 'second-password' } })).status === 200, '`admin reset-password` still works');
check((await req(CORE, '/api/fixture/ping')).status === 404, "THE CORE'S OWN SERVER HAS NONE OF THE EXTENSION'S ROUTES");

/* ----------------------------- 2. a deployment: the kit makes an account */

const depOptions = await req(DEP, '/api/auth/options');
check(depOptions.json?.passwordReset === true && depOptions.json?.signupUrl === '/fixture-signup', "the deployment's login page offers reset by email and its advertised sign-up page");
check((await req(DEP, '/api/fixture/ping')).json?.canSendEmail === true, "the extension's own route answers, and it can send email");

const dana = jar();
const danaEmail = `dana-m32-${stamp}@example.com`;
created.push(danaEmail);
const made = await req(DEP, '/api/fixture/accounts', {
  method: 'POST',
  body: { email: danaEmail, password: 'dana-old-pw', displayName: `dana-${stamp}`, teamName: `Dana's team ${stamp}` },
  jar: dana,
});
check(made.status === 201 && made.json.team?.name === `Dana's team ${stamp}`, 'createAccountWithOwnTeam makes an account and a team, and signs it in');
const danaTeams = (await req(DEP, '/api/teams', { jar: dana })).json;
check(danaTeams?.length === 2 && danaTeams[0].own === true && danaTeams[1].name === `Dana's team ${stamp}` && danaTeams.every((t) => t.role === 'owner' && t.memberCount === 1), "SHE IS ON EXACTLY TWO TEAMS, SELF AND HER OWN, ALONE IN BOTH (ADR 0051)");
const danaSessions = (await req(DEP, '/api/sessions', { jar: dana })).json;
check(Array.isArray(danaSessions) && danaSessions.every((s) => s.ownerSlug === made.json.user.ownerSlug), "she sees nobody else's sessions");
const verified = (await sql(`select email_verified_at is not null from users where email = '${danaEmail}'`)).trim();
check(verified === 't', 'the address is recorded as verified, as the deployment said');
check((await req(DEP, '/api/fixture/accounts', { method: 'POST', body: { email: danaEmail, password: 'whatever-pw', displayName: 'x', teamName: 'x' } })).status === 409, 'the same email cannot register twice');

const fede = jar();
await req(CORE, '/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede });
const fedeTeam = (await req(CORE, '/api/teams', { method: 'POST', body: { name: `Inviting ${stamp}` }, jar: fede })).json;
const invite = (await req(CORE, `/api/teams/${fedeTeam.id}/invites`, { method: 'POST', body: {}, jar: fede })).json;
check((await req(DEP, `/api/invites/${invite.token}/redeem`, { method: 'POST', jar: dana })).status === 200, "an invite still brings her into someone else's team");
check((await req(DEP, '/api/teams', { jar: dana })).json?.length === 3, '…and that is the only way she got there (Self, hers, and this one)');

/* ----------------------------- 3. password reset by email */

const danaOther = jar();
await req(DEP, '/api/auth/login', { method: 'POST', body: { email: danaEmail, password: 'dana-old-pw' }, jar: danaOther });
const asked = await req(DEP, '/api/auth/password-reset', { method: 'POST', body: { email: danaEmail } });
check(asked.status === 200, 'asking for a reset link is accepted');
let box = mails();
const resetMail = box.find((m) => m.to === danaEmail);
const token = resetMail && linkIn(resetMail);
check(!!token && resetMail.text.includes(`${DEP}/reset/`), 'an email arrives with a link to /reset/<token> on this instance');
const stored = (await sql(`select count(*) from password_resets where token_hash = '${token}'`)).trim();
check(stored === '0', 'the token itself is not stored (only its hash)');

check((await req(DEP, '/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'short' } })).status === 400, 'a too-short password is refused…');
const confirmed = await req(DEP, '/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'dana-new-pw' } });
check(confirmed.status === 200, '…and does not burn the link: a valid one then sets the new password');
check((await req(DEP, '/api/auth/login', { method: 'POST', body: { email: danaEmail, password: 'dana-old-pw' } })).status === 401, 'the old password stops working');
check((await req(DEP, '/api/auth/login', { method: 'POST', body: { email: danaEmail, password: 'dana-new-pw' } })).status === 200, 'the new one works');
check((await req(DEP, '/api/auth/me', { jar: dana })).status === 401 && (await req(DEP, '/api/auth/me', { jar: danaOther })).status === 401, 'EVERY OTHER LOGIN OF THE ACCOUNT IS SIGNED OUT');
check((await req(DEP, '/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'dana-third-pw' } })).status === 400, 'THE SAME LINK A SECOND TIME IS REFUSED');

await req(DEP, '/api/auth/password-reset', { method: 'POST', body: { email: danaEmail } });
const second = linkIn(mails().filter((m) => m.to === danaEmail).pop());
await sql(`update password_resets set expires_at = now() - interval '1 minute' where user_id = (select id from users where email = '${danaEmail}') and used_at is null`);
check((await req(DEP, '/api/auth/password-reset/confirm', { method: 'POST', body: { token: second, password: 'dana-third-pw' } })).status === 400, 'A LINK OLDER THAN AN HOUR IS REFUSED');

/* ----------------------------- 4. no account oracle, and a rate limit */

const before = mails().length;
const nobody = await req(DEP, '/api/auth/password-reset', { method: 'POST', body: { email: `nobody-${stamp}@example.com` } });
check(nobody.status === 200 && nobody.text === asked.text, 'AN ADDRESS WITH NO ACCOUNT GETS THE SAME ANSWER…');
check(mails().length === before, '…and no message is sent');
const flood = `flood-${stamp}@example.com`;
const statuses = [];
for (let i = 0; i < 6; i++) statuses.push((await req(DEP, '/api/auth/password-reset', { method: 'POST', body: { email: flood } })).status);
check(statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429, 'after five requests for one address, the sixth is refused (429)');

// Behind a proxy, the client is the address the proxy saw: the rightmost entry.
const fromProxy = (email, forwardedFor) =>
  fetch(`${DEP}/api/auth/password-reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor }, body: JSON.stringify({ email }) }).then((r) => r.status);
const client = `198.51.${stamp % 250}.${(stamp >> 8) % 250}`;
const forged = [];
for (let i = 0; i < 21; i++) forged.push(await fromProxy(`proxy-${i}-${stamp}@example.com`, `6.6.${i}.${i}, ${client}`));
check(forged.slice(0, 20).every((s) => s === 200) && forged[20] === 429, 'BEHIND A PROXY, A CLIENT CANNOT DODGE THE PER-IP LIMIT BY FORGING X-FORWARDED-FOR');
check((await fromProxy(`proxy-other-${stamp}@example.com`, `198.51.${(stamp % 250) + 1}.1`)) === 200, '…and another client behind the same proxy still gets through (not one shared count)');

/* ----------------------------------------------------------------- cleanup */

await req(CORE, `/api/teams/${fedeTeam.id}/members/${made.json.user.id}`, { method: 'DELETE', jar: fede });
for (const e of created) await admin(['delete-user', '--email', e]).catch(() => {});
deployment.kill();
rmSync(mailDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM32 checks passed');
