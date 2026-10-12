/**
 * M40 acceptance: deploy in one click. What can be checked without a Render
 * account:
 *   - render.yaml declares what the spec says (Docker build, a disk at /data,
 *     /health, managed Postgres 17 private to Render, a generated setup code,
 *     and nothing to fill in);
 *   - the image behaves as Render runs it: a disk mounted as root at /data, no
 *     PUBLIC_URL but RENDER_EXTERNAL_URL, no encryption key. It takes the
 *     platform's address, hands /data to its own user, never runs the server as
 *     root, and generates its key onto the disk.
 * The real deploy is done by hand, once per platform.
 *
 * Builds the image, so it runs only with FABRIKKA_TEST_DOCKER=1. Requires
 * Docker. Leaves nothing behind.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args) =>
  new Promise((ok, fail) =>
    execFile('docker', args, { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out + err))),
  );

/* ------------------------------------------------ 1. the Blueprint */

const bp = readFileSync('render.yaml', 'utf8');
check(/runtime:\s*docker/.test(bp) && /dockerfilePath:\s*\.\/docker\/Dockerfile/.test(bp), 'render.yaml builds the same image as self-hosting (docker/Dockerfile)');
check(/mountPath:\s*\/data/.test(bp), 'the service keeps a disk at /data (uploads and the generated key)');
check(/healthCheckPath:\s*\/health/.test(bp), 'Render watches /health');
check(/postgresMajorVersion:\s*"17"/.test(bp) && /fromDatabase:[\s\S]*?property:\s*connectionString/.test(bp), 'managed Postgres 17, wired to DATABASE_URL');
check(/ipAllowList:\s*\[\]/.test(bp), 'THE DATABASE IS REACHABLE ONLY FROM INSIDE RENDER (empty allow list)');
check(/key:\s*FABRIKKA_SETUP_CODE\s*\n\s*generateValue:\s*true/.test(bp), 'Render generates the setup code (ADR 0035)');
check(!/sync:\s*false/.test(bp) && !/^\s*-\s*key:\s*PUBLIC_URL/m.test(bp), 'nothing to fill in: no prompted values, and no PUBLIC_URL to type');

if (process.env.FABRIKKA_TEST_DOCKER !== '1') {
  console.log('skip the image half of M40: set FABRIKKA_TEST_DOCKER=1 to build and run it');
} else {
  /* ------------------------------------------------ 2. the image, run as Render runs it */

  const tag = 'fabrikka:m40check';
  const net = `m40-${Date.now()}`;
  const pg = `${net}-pg`;
  const app = `${net}-app`;
  const vol = `${net}-data`;
  const url = 'https://fabrikka-m40.onrender.com';
  try {
    await docker(['build', '-q', '-f', 'docker/Dockerfile', '-t', tag, '.']);
    await docker(['network', 'create', net]);
    await docker(['volume', 'create', vol]);
    // A disk that belongs to root, as a platform mounts it.
    await docker(['run', '--rm', '-v', `${vol}:/data`, '--entrypoint', 'sh', tag, '-c', 'chown root:root /data && chmod 755 /data']);
    await docker(['run', '-d', '--name', pg, '--network', net, '-e', 'POSTGRES_USER=fabrikka', '-e', 'POSTGRES_PASSWORD=m40', '-e', 'POSTGRES_DB=fabrikka', 'postgres:17-alpine']);
    for (let i = 0; i < 60; i++) {
      if (await docker(['exec', pg, 'pg_isready', '-U', 'fabrikka']).then(() => true, () => false)) break;
      await sleep(1000);
    }
    await docker([
      'run', '-d', '--name', app, '--network', net, '-v', `${vol}:/data`, '-p', '18090:8080',
      '-e', `DATABASE_URL=postgres://fabrikka:m40@${pg}:5432/fabrikka`,
      '-e', `RENDER_EXTERNAL_URL=${url}`,
      '-e', 'FABRIKKA_SETUP_CODE=render-generated-value',
      tag,
    ]);
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      up = await fetch('http://127.0.0.1:18090/health').then((r) => r.ok, () => false);
      if (!up) await sleep(1000);
    }
    check(up, 'the image starts on a root-owned disk with nothing but DATABASE_URL and what Render sets');
    const logs = await docker(['logs', app]);
    check(logs.includes(`PUBLIC_URL is ${url}`), "it takes its address from RENDER_EXTERNAL_URL, so nobody types PUBLIC_URL");
    check(/generated an encryption key/.test(logs), 'it generates its encryption key onto the disk');
    const uid = await docker(['exec', app, 'sh', '-c', "awk '/^Uid:/{print $2}' /proc/1/status"]);
    check(uid.trim() === '1000', 'THE SERVER RUNS AS THE UNPRIVILEGED `node` USER, NOT ROOT');
    const owner = await docker(['exec', app, 'stat', '-c', '%U', '/data']);
    check(owner.trim() === 'node', '…and /data now belongs to it');
    const install = await (await fetch('http://127.0.0.1:18090/install.sh')).text();
    check(install.includes(url), 'the client installer names the platform address');
    const setup = await fetch('http://127.0.0.1:18090/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'render-generated-value', email: 'owner@m40.example', displayName: 'M40', password: 'm40-owner-password' }),
    });
    check(setup.status === 201, 'the setup code Render generated creates the owner');

    /* ---------------------------------------------- 3. the same image, as Fly.io runs it */

    await docker(['rm', '-f', app]);
    await docker([
      'run', '-d', '--name', app, '--network', net, '-v', `${vol}:/data`, '-p', '18090:8080',
      '-e', `DATABASE_URL=postgres://fabrikka:m40@${pg}:5432/fabrikka`,
      '-e', 'FLY_APP_NAME=fabrikka-m40',
      '-e', 'FABRIKKA_MAIL=file:/data/mail',
      tag,
    ]);
    let flyUp = false;
    for (let i = 0; i < 90 && !flyUp; i++) {
      flyUp = await fetch('http://127.0.0.1:18090/health').then((r) => r.ok, () => false);
      if (!flyUp) await sleep(1000);
    }
    check(flyUp, 'on Fly.io (FLY_APP_NAME), the image starts with nothing else set');
    const flyLogs = await docker(['logs', app]);
    check(flyLogs.includes('PUBLIC_URL is https://fabrikka-m40.fly.dev'), 'it takes its address from the Fly app name');
    check(/read from the platform's fly-client-ip header/.test(flyLogs), "it reads the client from Fly-Client-IP, not X-Forwarded-For (whose last entry is the app's own address there)");
    const reset = (ip, forged) =>
      fetch('http://127.0.0.1:18090/api/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': ip, 'x-forwarded-for': forged },
        body: JSON.stringify({ email: `x-${Math.random()}@m40.example` }),
      }).then((r) => r.status);
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push(await reset('198.51.100.40', `6.6.6.${i}, 203.0.113.1`));
    check(codes.slice(0, 20).every((c) => c === 200) && codes[20] === 429, 'ONE FLY CLIENT IS LIMITED, WHATEVER X-FORWARDED-FOR IT FORGES');
    check((await reset('198.51.100.41', '203.0.113.1')) === 200, '…and another client is counted separately');
  } catch (err) {
    console.error('FAIL', err.message);
    failures++;
  } finally {
    for (const args of [['rm', '-f', app, pg], ['volume', 'rm', '-f', vol], ['network', 'rm', net]]) await docker(args).catch(() => {});
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM40 checks passed');
process.exit(0);
