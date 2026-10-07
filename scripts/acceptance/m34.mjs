/**
 * M34 acceptance: the desktop app runs your agents (ADR 0031).
 *
 * What can be checked without a person at the app:
 *   - the host under `--control stdio`: protocol-only stdout, no listening port,
 *     its operations and refusals, pairing pushed as an event;
 *   - one host per machine (the lock);
 *   - the capability files: host commands for the local Folders window only, and
 *     no remote URL anywhere;
 *   - the built app: its client is the one the instance serves, and its bundled
 *     Node really runs code (the JIT entitlement);
 *   - `install.sh --app`, into a scratch HOME, with no Node on the PATH.
 * The tray, the folder picker and the in-app pairing click are the manual test.
 *
 * Requires: the core server on :9090, the test account. The app checks run when
 * `pnpm --filter @fabrikka/desktop package` has been run (macOS, Apple Silicon).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CORE = 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const CLI = 'packages/bridge/dist/cli.js';
const APP = 'apps/desktop/src-tauri/target/release/bundle/macos/Fabrikka.app';
const ZIP = 'apps/desktop/dist-app/Fabrikka-macos-arm64.zip';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const skip = (m) => console.log('skip', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sh = (line, env) =>
  new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', line], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
const api = (path, init = {}) => fetch(`${CORE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie } });

/* --------------------------------------------- 1. the host over stdio */

const hostHome = mkdtempSync(join(tmpdir(), 'm34-host-'));
const project = mkdtempSync(join(tmpdir(), 'm34-project-'));
const hostEnv = { ...process.env, FABRIKKA_HOST_HOME: hostHome, FABRIKKA_NO_BROWSER: '1' };
const host = spawn('node', [CLI, 'host', '--server', CORE, '--control', 'stdio'], { env: hostEnv, stdio: ['pipe', 'pipe', 'pipe'] });
const stdoutLines = [];
const pending = new Map();
let pairEvent = null;
createInterface({ input: host.stdout }).on('line', (line) => {
  stdoutLines.push(line);
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.event === 'pair') pairEvent = m;
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
let nextId = 0;
const ask = (req) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    host.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    setTimeout(() => pending.has(id) && (pending.delete(id), resolve({ ok: false, error: 'timeout' })), 8000);
  });

for (let i = 0; i < 40 && !pairEvent; i++) await sleep(250);
check(pairEvent && pairEvent.url.startsWith(`${CORE}/pair/`) && pairEvent.code, 'PAIRING IS PUSHED AS AN EVENT, for the app to open in its own window');
await api('/devices/pair/confirm', { method: 'POST', body: JSON.stringify({ code: pairEvent?.code }) });
let state = null;
for (let i = 0; i < 40; i++) {
  const r = await ask({ op: 'state' });
  if (r.ok && r.state.connected) {
    state = r.state;
    break;
  }
  await sleep(500);
}
check(state?.connected === true, 'after the pairing click, the host connects and reports its state over stdio');

const listening = (() => {
  try {
    return execFileSync('lsof', ['-a', '-p', String(host.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();
check(listening === '', 'NO PORT: the stdio host listens on no TCP port');

const granted = await ask({ op: 'grant', path: project, policy: 'edit' });
check(granted.ok && granted.grant?.policy === 'edit', 'a folder is granted, Edit in folder');
check((await ask({ op: 'grant', path: process.env.HOME })).error?.includes('home folder'), 'YOUR HOME FOLDER IS REFUSED, exactly as on the local page');
check((await ask({ op: 'grant', path: join(project, 'nope') })).error?.includes('does not exist'), 'a missing folder is refused');
check((await ask({ op: 'grant', path: project })).error?.includes('already granted'), 'the same folder twice is refused');
check((await ask({ op: 'policy', grantId: granted.grant?.id, policy: 'root' })).ok === false, 'an unknown policy is refused');
check((await ask({ op: 'policy', grantId: granted.grant?.id, policy: 'read' })).ok === true, 'a policy changes');
const after = (await ask({ op: 'state' })).state;
check(after.grants.length === 1 && after.grants[0].policy === 'read', '…and the state shows it');
check((await ask({ op: 'stop' })).ok === true, 'stop all runs answers');
check((await ask({ op: 'teleport' })).ok === false, 'an unknown operation is refused');
check((await ask({ op: 'remove', grantId: granted.grant?.id })).ok && (await ask({ op: 'state' })).state.grants.length === 0, 'a folder is removed');
// Grant, policy, remove in quick succession: the server once crashed on this.
check((await fetch(`${CORE}/health`).catch(() => null))?.ok === true, 'THE SERVER IS STILL UP after a burst of grant changes from one host');
check(stdoutLines.length > 0 && stdoutLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), 'EVERY STDOUT LINE IS PROTOCOL: logs stay on stderr');

/* --------------------------------------------- 2. one host per machine */

const second = await sh(`FABRIKKA_HOST_HOME='${hostHome}' FABRIKKA_NO_BROWSER=1 node ${CLI} host --server ${CORE}`, process.env);
check(second.code === 3 && /already running/.test(second.out), 'A SECOND HOST ON THE SAME MACHINE REFUSES TO START (the lock)');
host.stdin.end(); // the app going away
for (let i = 0; i < 20 && host.exitCode === null; i++) await sleep(250);
check(host.exitCode === 0, 'closing its stdin stops the stdio host');
check(!existsSync(join(hostHome, 'host.lock')), '…and releases the lock');

// The app quitting while its host still waits to pair: the host must not linger.
const pairingHome = mkdtempSync(join(tmpdir(), 'm34-pairing-'));
const waiting = spawn('node', [CLI, 'host', '--server', CORE, '--control', 'stdio'], {
  env: { ...process.env, FABRIKKA_HOST_HOME: pairingHome },
  stdio: ['pipe', 'pipe', 'ignore'],
});
const waitingLines = [];
createInterface({ input: waiting.stdout }).on('line', (l) => waitingLines.push(l));
for (let i = 0; i < 40 && !waitingLines.some((l) => l.includes('"pair"')); i++) await sleep(250);
waiting.stdin.write(JSON.stringify({ id: 1, op: 'state' }) + '\n');
for (let i = 0; i < 20 && !waitingLines.some((l) => l.includes('"id":1')); i++) await sleep(100);
check(waitingLines.some((l) => l.includes('"id":1') && l.includes('waiting for you to confirm')), "while pairing, the app's questions get an answer: waiting for you to confirm");
waiting.stdin.end();
for (let i = 0; i < 20 && waiting.exitCode === null; i++) await sleep(250);
check(waiting.exitCode === 0, 'AN APP QUIT MID-PAIRING ENDS ITS HOST: nothing lingers');
if (waiting.exitCode === null) waiting.kill();
rmSync(pairingHome, { recursive: true, force: true });

/* --------------------------------------------- 3. capabilities */

const capDir = 'apps/desktop/src-tauri/capabilities';
const caps = readdirSync(capDir).map((f) => JSON.parse(readFileSync(join(capDir, f), 'utf8')));
const hostPerms = (c) => c.permissions.filter((p) => String(p).startsWith('allow-host-'));
check(caps.every((c) => !('remote' in c)), 'no capability file names a remote URL');
check(caps.filter((c) => hostPerms(c).length).every((c) => JSON.stringify(c.windows) === '["folders"]'), 'HOST COMMANDS ARE GRANTED ONLY TO THE LOCAL FOLDERS WINDOW');
check(hostPerms(caps.find((c) => c.windows.includes('main')) ?? { permissions: [] }).length === 0, 'the main window gets none of them');
const mainRs = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
const runtimeGrants = [...mainRs.matchAll(/\.permission\("([^"]+)"\)/g)].map((m) => m[1]);
check(JSON.stringify(runtimeGrants) === '["allow-open-folders"]' && /\.remote\(format!\("\{origin\}\/\*"\)\)/.test(mainRs) && /\.window\("main"\)/.test(mainRs), "THE INSTANCE'S PAGES GET ONE COMMAND, open_folders, FOR ITS OWN ORIGIN ONLY, granted at runtime");
check(/fn open_folders\(app: AppHandle\)/.test(mainRs), 'open_folders takes no argument: no path, no policy');
const manifest = readFileSync('apps/desktop/src-tauri/build.rs', 'utf8');
check(['host_state', 'host_add_folder', 'host_policy', 'host_remove', 'host_stop'].every((c) => manifest.includes(`"${c}"`)), 'every host command is in the app manifest, so none is callable without a permission');

/* --------------------------------------------- 4. the built app */

if (process.platform === 'darwin' && process.arch === 'arm64' && existsSync(APP) && existsSync(ZIP)) {
  // M33's check rebuilds the client, so an app packaged before that is honestly
  // one version behind: compare only when the app is the newer of the two.
  if (statSync(ZIP).mtimeMs >= statSync(CLI).mtimeMs) {
    const served = Buffer.from(await (await fetch(`${CORE}/downloads/fabrikka.mjs`)).arrayBuffer());
    check(sha256(readFileSync(join(APP, 'Contents/Resources/fabrikka.mjs'))) === sha256(served), "THE APP'S CLIENT IS BYTE-IDENTICAL TO THE ONE THE INSTANCE SERVES");
  } else {
    skip('app client vs served client: the client was rebuilt after the app was packaged (repackage to compare)');
  }
  const ran = await sh(`'${APP}/Contents/MacOS/node' -e "let s=0;for(let i=0;i<1e7;i++)s+=i;console.log(s)"`, process.env);
  check(ran.code === 0 && ran.out.trim() === '49999995000000', 'its bundled Node runs real code under the hardened runtime (JIT entitled)');

  /* ------------------------------------------- 5. install.sh --app */

  const home = mkdtempSync(join(tmpdir(), 'm34-home-'));
  const noNode = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' };
  const inst = await sh(`curl -fsSL ${CORE}/install.sh | bash -s -- --app --no-connect`, noNode);
  const installed = join(home, 'Applications/Fabrikka.app');
  check(inst.code === 0 && existsSync(join(installed, 'Contents/MacOS/node')), '`--app` installs Fabrikka.app into ~/Applications — WITH NO NODE ON THE PATH');
  check(readFileSync(join(home, 'Library/Application Support/dev.fabrikka.app/server-url'), 'utf8') === CORE, "it points the app at this instance, so first launch goes to sign-in");
  const quarantined = await sh(`xattr -p com.apple.quarantine '${installed}'`, process.env);
  check(quarantined.code !== 0, 'the installed app carries no quarantine flag, so it opens without a Gatekeeper prompt');
  check(!existsSync(join(home, '.zshrc')) && !existsSync(join(home, '.local')), 'and it touches no PATH and installs no command-line client');

  const fakeHome = mkdtempSync(join(tmpdir(), 'm34-fake-'));
  const script = await (await fetch(`${CORE}/install.sh`)).text();
  const zip = readFileSync(ZIP);
  const fake = createServer((req, res) => {
    if (req.url === '/install.sh') return res.end(script.replace(`FABRIKKA_SERVER='${CORE}'`, `FABRIKKA_SERVER='http://localhost:9198'`));
    if (req.url?.endsWith('.zip.sha256')) return res.end(`${'0'.repeat(64)}  Fabrikka-macos-arm64.zip\n`);
    if (req.url?.endsWith('.zip')) return res.end(zip);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => fake.listen(9198, r));
  const tampered = await sh('curl -fsSL http://localhost:9198/install.sh | bash -s -- --app --no-connect', { ...noNode, HOME: fakeHome });
  fake.close();
  check(tampered.code !== 0 && /doesn't match its checksum/.test(tampered.out) && !existsSync(join(fakeHome, 'Applications/Fabrikka.app')), 'A MISMATCHED APP CHECKSUM IS REFUSED, and nothing is installed');
  rmSync(home, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
} else {
  skip('the built app and --app (run `pnpm --filter @fabrikka/desktop package` on macOS, Apple Silicon)');
}

/* ----------------------------------------------------------------- cleanup */

const devices = await (await api('/devices')).json();
for (const d of devices) {
  if (Date.now() - new Date(d.lastSeenAt ?? 0).getTime() < 5 * 60_000) await api(`/devices/${d.id}`, { method: 'DELETE' });
}
if (host.exitCode === null) host.kill();
rmSync(hostHome, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM34 checks passed');
process.exit(0);
