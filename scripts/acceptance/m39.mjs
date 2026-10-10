/**
 * M39 acceptance: one image, one compose file. Self-hosting end to end.
 *
 * Brings up docker/selfhost/compose.yaml (the server, Postgres, Caddy) as its
 * own compose project on spare ports, with `localhost` as the domain, and checks
 * what the manual test does, minus the real domain:
 *   - migrations run at start (setup works on an empty database);
 *   - the first owner is created in the browser with the setup code from the
 *     log, and setup is gone afterwards (ADR 0035);
 *   - a room survives a restart;
 *   - the instance serves its own client installer, under the AGPL;
 *   - with no key configured, the image generates one and reuses it.
 *
 * Takes minutes (it builds the image), so it runs only with
 * FABRIKKA_TEST_DOCKER=1, as the spawn checks run only with FABRIKKA_TEST_SPAWN.
 * Requires Docker with Compose v2. Leaves nothing behind (`down -v`).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.FABRIKKA_TEST_DOCKER !== '1') {
  console.log('skip M39: set FABRIKKA_TEST_DOCKER=1 to build the image and run the self-hosted stack');
  process.exit(0);
}

// Caddy serves `localhost` with its own local CA. Trusting it is fine for this
// process only: every request below goes to this machine.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PROJECT = 'fabrikka-m39check';
const HTTPS = 18443;
const BASE = `https://localhost:${HTTPS}`;

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, opts = {}) =>
  new Promise((ok, fail) =>
    execFile('docker', args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out + err))),
  );

// An env file like init.sh writes, minus the encryption key: the image must make one.
const dir = mkdtempSync(join(tmpdir(), 'm39-'));
const envFile = join(dir, '.env');
writeFileSync(
  envFile,
  [`FABRIKKA_DOMAIN=localhost`, `PUBLIC_URL=${BASE}`, `POSTGRES_PASSWORD=m39-${Date.now()}`, `HTTP_PORT=18080`, `HTTPS_PORT=${HTTPS}`].join('\n') + '\n',
);
const compose = (...args) => run(['compose', '-p', PROJECT, '-f', 'docker/selfhost/compose.yaml', '--env-file', envFile, ...args]);

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

try {
  /* ------------------------------------------------ 1. up from nothing */

  await compose('up', '-d', '--build');
  check(await waitUp(), 'the stack comes up behind Caddy, over HTTPS');

  const logs = await compose('logs', 'server');
  check(/generated an encryption key/.test(logs), 'with no key configured, the image generates one into /data');
  const code = logs.match(/\b([0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5})\b/)?.[1];
  check(!!code, 'the server prints a setup code in its log');

  /* ------------------------------------------------ 2. setup (ADR 0035) */

  const needed = await (await fetch(`${BASE}/api/setup`)).json();
  check(needed.needed === true, 'migrations ran at start, and the empty instance says it needs its owner');

  const owner = { email: 'owner@m39.example', displayName: 'M39 Owner', password: 'm39-owner-password' };
  const wrong = await fetch(`${BASE}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...owner, code: 'AAAAA-AAAAA-AAAAA-AAAAA' }) });
  check(wrong.status === 403, 'A WRONG SETUP CODE CREATES NOTHING');

  const made = await fetch(`${BASE}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...owner, code: (code ?? '').toLowerCase() }) });
  const cookie = made.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0] ?? '';
  const madeBody = await made.json().catch(() => ({}));
  check(made.status === 201 && madeBody.user?.isInstanceOwner === true && !!cookie, 'the right code (any case) creates the instance owner and signs them in');

  check((await (await fetch(`${BASE}/api/setup`)).json()).needed === false, 'afterwards the instance no longer needs setup');
  const again = await fetch(`${BASE}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...owner, email: 'second@m39.example', code }) });
  check(again.status === 404, 'SETUP IS GONE ONCE ANYONE EXISTS, even with the right code');

  /* ------------------------------------------------ 3. a room, and a restart */

  const created = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'First room' }) });
  check(created.status === 201 || created.status === 200, 'the owner creates a room');

  await compose('restart', 'server');
  check(await waitUp(), 'the server comes back after a restart');
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
  const cookie2 = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0] ?? '';
  check(login.ok, 'the owner still signs in after the restart (Postgres kept its data)');
  const list = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie: cookie2 } })).json().catch(() => null);
  check(JSON.stringify(list ?? '').includes('First room'), '…and the room is still there');
  const logs2 = await compose('logs', 'server');
  check((logs2.match(/generated an encryption key/g) ?? []).length === 1, 'the generated key is reused, not regenerated, on restart');

  /* ------------------------------------------------ 4. the client and the web app */

  const install = await fetch(`${BASE}/install.sh`);
  const script = await install.text();
  check(install.ok && script.includes(BASE) && /AGPL/.test(script), "the instance serves its own client installer, naming itself and the AGPL");
  const page = await fetch(`${BASE}/setup`);
  check(page.ok && (await page.text()).includes('<div id="root">'), 'the built web app is served (the /setup page loads the app)');
} catch (err) {
  console.error('FAIL', err.message);
  failures++;
} finally {
  await compose('down', '-v').catch(() => {});
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM39 checks passed');
process.exit(0);
