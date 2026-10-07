/**
 * M33 acceptance: install the client with one line, from your own instance
 * (ADR 0030).
 *
 * Runs the real installer, through `curl … | bash`, into a scratch HOME, against
 * a test instance on its own port (the M32 fixture deployment), so this
 * machine's own ~/.local, ~/.zshrc and ~/.fabrikka are never touched. It also
 * rebuilds the client, to prove "update available" and `fabrikka update`. The
 * build output is gitignored.
 *
 * Requires: the core server on :9090, the test account.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CORE = 'http://localhost:9090';
const PORT = 9196;
const INSTANCE = `http://localhost:${PORT}`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const DIST = 'packages/bridge/dist';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Run a shell command line in the scratch environment; resolves {code, out}. */
const sh = (line, env) =>
  new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', line], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

/* ------------------------------------------------ a scratch home and instance */

const home = mkdtempSync(join(tmpdir(), 'm33-home-'));
const nodeDir = dirname(process.execPath);
// A PATH with node and curl but without any ~/.local/bin, so the PATH step runs.
const basePath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', nodeDir].join(':');
const env = {
  HOME: home,
  SHELL: '/bin/zsh',
  PATH: basePath,
  FABRIKKA_NO_BROWSER: '1',
  FABRIKKA_HOST_PORT: '17699',
};

function startInstance() {
  const child = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', '../../scripts/fixtures/extension-server.mts'], {
    cwd: 'apps/server',
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: INSTANCE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return child;
}
async function waitUp(url) {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${url}/health`).catch(() => null))?.ok) return true;
    await sleep(500);
  }
  return false;
}
let instance = startInstance();
await waitUp(INSTANCE);

/* ------------------------------------- 1. one file, nothing beside it */

const lone = mkdtempSync(join(tmpdir(), 'm33-lone-'));
copyFileSync(`${DIST}/cli.js`, join(lone, 'fabrikka.mjs'));
const built = JSON.parse(readFileSync(`${DIST}/version.json`, 'utf8')).version;
const loneVersion = await sh(`cd "${lone}" && node fabrikka.mjs --version`, { PATH: basePath });
check(loneVersion.code === 0 && loneVersion.out.trim() === built, 'THE CLIENT RUNS ALONE: one file in an empty folder, no node_modules');

/* ------------------------------------- 2. what an instance serves */

const script = await (await fetch(`${CORE}/install.sh`)).text();
check(script.includes(`FABRIKKA_SERVER='${CORE}'`) && script.trimEnd().endsWith('main "$@"'), "the core serves an installer with its own address written in, run from its last line");
const coreManifest = await (await fetch(`${CORE}/downloads/manifest.json`)).json();
const coreFile = Buffer.from(await (await fetch(`${CORE}/downloads/fabrikka.mjs`)).arrayBuffer());
check(coreManifest.sha256 === sha256(coreFile) && coreManifest.node === '>=22', "its manifest's checksum matches the file it serves");
check((await (await fetch(`${CORE}/api/client`)).json()).installCommand === `curl -fsSL ${CORE}/install.sh | bash`, '"Your devices" gets the command for this instance');
check(!/^\s*sudo\b/m.test(script) && !/(brew|apt-get|apt|npm)\s+(i|install)\b/.test(script), 'THE INSTALLER NEVER RUNS sudo, AND INSTALLS NOTHING BUT THE CLIENT');

/* ------------------------------------- 3. install (no connect) */

const install = (args = '') => sh(`curl -fsSL ${INSTANCE}/install.sh | bash -s -- --no-connect ${args}`, env);
const first = await install();
const launcher = join(home, '.local/bin/fabrikka');
const file = join(home, '.local/share/fabrikka/fabrikka.mjs');
check(first.code === 0 && existsSync(launcher) && existsSync(file), 'one pasted command installs the client and a `fabrikka` launcher');
check((statSync(launcher).mode & 0o111) !== 0, 'the launcher is executable');
const rcLines = () => readFileSync(join(home, '.zshrc'), 'utf8').split('\n').filter((l) => l.includes('added by the Fabrikka installer'));
check(rcLines().length === 1, '~/.local/bin is added to the PATH in ~/.zshrc, once');
await install();
check(rcLines().length === 1, 'RUNNING IT AGAIN DOES NOT ADD A SECOND PATH LINE');
const instanceManifest = await (await fetch(`${INSTANCE}/downloads/manifest.json`)).json();
check((await sh(`"${launcher}" --version`, env)).out.trim() === instanceManifest.version, "the installed client is the instance's version");
check(/agent tools found: Claude Code|no agent tools found/.test(first.out), 'it reports which agent tools are installed, and installs none');
const noPath = mkdtempSync(join(tmpdir(), 'm33-home2-'));
await sh(`curl -fsSL ${INSTANCE}/install.sh | bash -s -- --no-connect --no-modify-path`, { ...env, HOME: noPath });
check(!existsSync(join(noPath, '.zshrc')), '--no-modify-path leaves the shell startup file alone');

/* ------------------------------------- 4. a mismatched checksum installs nothing */

const fakeHome = mkdtempSync(join(tmpdir(), 'm33-fake-'));
const fake = createServer((req, res) => {
  if (req.url === '/install.sh') return res.end(script.replace(`FABRIKKA_SERVER='${CORE}'`, `FABRIKKA_SERVER='http://localhost:9197'`));
  if (req.url === '/downloads/manifest.json') {
    return res.end(JSON.stringify({ ...coreManifest, url: 'http://localhost:9197/downloads/fabrikka.mjs', sha256: '0'.repeat(64) }));
  }
  if (req.url === '/downloads/fabrikka.mjs') return res.end(coreFile);
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => fake.listen(9197, r));
const tampered = await sh('curl -fsSL http://localhost:9197/install.sh | bash -s -- --no-connect', { ...env, HOME: fakeHome });
fake.close();
check(tampered.code !== 0 && /doesn't match its checksum/.test(tampered.out), 'A FILE THAT DOES NOT MATCH THE MANIFEST IS REFUSED…');
check(!existsSync(join(fakeHome, '.local/bin/fabrikka')) && !existsSync(join(fakeHome, '.local/share/fabrikka/fabrikka.mjs')), '…and nothing is installed');

/* ------------------------------------- 5. refusals before anything is fetched */

const insecure = script.replace(`FABRIKKA_SERVER='${CORE}'`, `FABRIKKA_SERVER='http://example.com'`);
const http = await sh(`bash -s -- --no-connect <<'EOF'\n${insecure}\nEOF`, env);
check(http.code !== 0 && /isn't https/.test(http.out), 'PLAIN http:// FROM A NON-LOCAL ADDRESS IS REFUSED');
const noNodeHome = mkdtempSync(join(tmpdir(), 'm33-nonode-'));
const noNode = await sh(`curl -fsSL ${INSTANCE}/install.sh | bash -s -- --no-connect`, { ...env, HOME: noNodeHome, PATH: '/usr/bin:/bin' });
check(noNode.code !== 0 && /needs Node\.js 22/.test(noNode.out) && !existsSync(join(noNodeHome, '.local')), 'without Node 22+, it stops with directions and installs nothing');

/* ------------------------------------- 6. connect: the installer ends in pairing */

const fede = { cookie: '' };
const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
fede.cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
const api = (path, init = {}) => fetch(`${CORE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie: fede.cookie, ...(init.headers ?? {}) } });

let hostOut = '';
// Its own process group: the installer ends by exec'ing the host, so stopping
// the shell alone would leave the host running.
const host = spawn('/bin/sh', ['-c', `curl -fsSL ${INSTANCE}/install.sh | bash`], { env, detached: true });
host.stdout.on('data', (d) => (hostOut += d));
host.stderr.on('data', (d) => (hostOut += d));
let code = null;
for (let i = 0; i < 60 && !code; i++) {
  code = hostOut.match(/\/pair\/([A-Z0-9-]+)/)?.[1] ?? null;
  await sleep(500);
}
check(!!code && hostOut.includes(`${INSTANCE}/pair/`), "after installing, it starts the host, which asks to pair with this instance");
await api('/devices/pair/confirm', { method: 'POST', body: JSON.stringify({ code }) });
for (let i = 0; i < 40 && !hostOut.includes(`connected to ${INSTANCE}`); i++) await sleep(500);
check(hostOut.includes(`connected to ${INSTANCE}`), 'one click on the pairing page connects it: the installed host is running');
check(existsSync(join(home, '.fabrikka/host.json')), "its pairing is kept in the scratch home's ~/.fabrikka, not this machine's");

/* ------------------------------------- 7. update available, then update */

check(!hostOut.includes('update available'), 'an up-to-date host says nothing about updates');
const rebuilt = await new Promise((r) => execFile('pnpm', ['--filter', '@fabrikka/bridge', 'build'], (e) => r(!e)));
await sleep(1100);
const newVersion = JSON.parse(readFileSync(`${DIST}/version.json`, 'utf8')).version;
check(rebuilt && newVersion !== built, 'the client is rebuilt with a new version');
instance.kill();
await sleep(1000);
instance = startInstance();
await waitUp(INSTANCE);
for (let i = 0; i < 60 && !hostOut.includes('update available'); i++) await sleep(500);
check(hostOut.includes(`update available: ${instanceManifest.version} → ${newVersion}`), 'AFTER THE SERVER RESTARTS, THE CONNECTED HOST SAYS AN UPDATE IS AVAILABLE');
check((await sh(`"${launcher}" --version`, env)).out.trim() === instanceManifest.version, '…and has not updated itself');
const updated = await sh(`"${launcher}" update`, env);
check(updated.code === 0 && (await sh(`"${launcher}" --version`, env)).out.trim() === newVersion, '`fabrikka update` installs the new client, checksum-verified');
const notOurs = await sh(`node ${process.cwd()}/${DIST}/cli.js update --server ${INSTANCE}`, env);
check(notOurs.code !== 0 && /wasn't installed by the installer/.test(notOurs.out), 'it refuses to overwrite a copy the installer did not put there');

/* ----------------------------------------------------------------- cleanup */

try {
  process.kill(-host.pid, 'SIGTERM');
} catch {
  // already gone
}
const mine = await (await api('/devices')).json();
for (const d of mine.filter((d) => d.online || d.lastSeenAt)) {
  // Only the device this run paired: the scratch host's name is this machine's, so match on recency.
  if (Date.now() - new Date(d.lastSeenAt ?? 0).getTime() < 5 * 60_000) await api(`/devices/${d.id}`, { method: 'DELETE' });
}
instance.kill();
for (const d of [home, lone, noPath, fakeHome, noNodeHome]) rmSync(d, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM33 checks passed');
process.exit(0);
