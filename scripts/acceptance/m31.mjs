/**
 * M31 acceptance: the local host — your agents, in folders you grant, safely.
 *
 * Drives the real `fabrikka host` process, as the acceptance test account:
 *   - pairing: the host asks, a signed-in person confirms, the host gets a token once;
 *   - grants are made on the machine (the host's local page), never from the server:
 *     home and root refused, cross-origin and wrong-Host requests refused;
 *   - the server stores labels, never paths;
 *   - "Add my agent" binds an agent to a grant; the host runs it through an
 *     ordinary runner connection; unknown grants and other people's devices refused;
 *   - revoking the device on the web disconnects it.
 * With FABRIKKA_TEST_SPAWN=1, real runs too: an edit inside the folder lands,
 * and a read-only grant leaves the file untouched.
 *
 * Requires: server on :9090, the bridge built (pnpm --filter @fabrikka/bridge build).
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'http://localhost:9090';
const API = `${ORIGIN}/api`;
const MCP = `${ORIGIN}/mcp`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jar() {
  let cookie = '';
  return {
    get headers() {
      return cookie ? { cookie } : {};
    },
    get cookie() {
      return cookie;
    },
    capture(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        if (pair?.startsWith('fabrikka_session=')) cookie = pair;
      }
    },
  };
}

async function req(path, { method = 'GET', body, jar: j } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(j?.headers ?? {}),
    },
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
  return { status: res.status, json };
}

const stamp = Date.now();
const SPAWN = !!process.env.FABRIKKA_TEST_SPAWN;
const me = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: me })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'm31-host-'));
const demo = join(home, 'demo');
mkdirSync(demo);
writeFileSync(join(demo, 'typo.txt'), 'teh quick brown fox\n');
const PORT = 17000 + Math.floor(Math.random() * 900);

/* ------------------------------------------------------------- pairing */

const lines = [];
const host = spawn(process.execPath, ['packages/bridge/dist/cli.js', 'host', '--server', ORIGIN], {
  env: { ...process.env, FABRIKKA_HOST_HOME: home, FABRIKKA_HOST_PORT: String(PORT), FABRIKKA_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
host.stderr.on('data', (d) => lines.push(...String(d).split('\n')));
const waitFor = async (re, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = lines.map((l) => re.exec(l)).find(Boolean);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
};
const cleanup = () => host.kill('SIGTERM');

try {
  const code = (await waitFor(/confirm the code ([A-Z0-9]{4}-[A-Z0-9]{4})/))?.[1];
  check(!!code, 'the host asks to pair and shows a code');
  check(!!(await waitFor(/\/pair\/[A-Z0-9]{4}-[A-Z0-9]{4}/)), 'and the link to confirm it (the code in the path, so sign-in keeps it)');
  check((await req(`/devices/pair/${code}`, { jar: me })).json?.deviceName, 'the pair page names the device');
  check((await req('/devices/pair/confirm', { method: 'POST', body: { code }, jar: me })).status === 200, 'a signed-in person confirms it — one click');
  check(!!(await waitFor(/connected as/)), 'the host receives its token');
  const cfg = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8'));
  check(!!cfg.deviceToken, 'and keeps it in its own config');
  check((await req('/devices/pair/confirm', { method: 'POST', body: { code }, jar: me })).status === 400, 'a code works once');

  let devs = (await req('/devices', { jar: me })).json;
  // By name, newest first: an earlier run (or a person's own machine) may have
  // left a device with the same name on this account. The one just paired
  // hasn't been seen yet, so a missing lastSeenAt sorts first.
  const lastSeen = (d) => d.lastSeenAt ?? '9999';
  const dev = devs.filter((d) => d.name === cfg.deviceName).sort((a, b) => String(lastSeen(b)).localeCompare(String(lastSeen(a))))[0];
  check(!!dev, 'Your devices lists the computer');
  for (let i = 0; i < 50 && !(await req('/devices', { jar: me })).json.find((d) => d.id === dev.id)?.online; i++) await sleep(100);
  check((await req('/devices', { jar: me })).json.find((d) => d.id === dev.id)?.online === true, '…online');

  /* -------------------------------------------- grants, on the machine only */

  const controlUrl = (await waitFor(/(http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]+)/))?.[1];
  check(!!controlUrl, 'the host prints the link to its own page');
  const ctl = new URL(controlUrl);
  const enter = await fetch(controlUrl, { redirect: 'manual' });
  const cookie = enter.headers.getSetCookie()[0].split(';')[0];
  const local = (path, init = {}) =>
    fetch(`${ctl.origin}${path}`, {
      ...init,
      headers: { cookie, origin: ctl.origin, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  check((await fetch(`${ctl.origin}/api/state`)).status === 403, 'the host page refuses requests without its secret');
  check((await local('/api/grants', { method: 'POST', body: JSON.stringify({ path: demo }), headers: { origin: 'http://evil.example' } })).status === 403, 'a request from another website is refused (CSRF)');
  // fetch() silently drops a custom Host header, so use node:http, which sends it.
  const rebound = await new Promise((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port: ctl.port, path: '/api/state', headers: { cookie, host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(0));
    r.end();
  });
  check(rebound === 403, 'a request under another host name is refused (DNS rebinding)');
  check((await local('/api/grants', { method: 'POST', body: JSON.stringify({ path: homedir() }) })).status === 400, 'your home folder cannot be granted');
  check((await local('/api/grants', { method: 'POST', body: JSON.stringify({ path: '/' }) })).status === 400, 'nor a whole disk');
  const granted = await local('/api/grants', { method: 'POST', body: JSON.stringify({ path: demo, policy: 'edit' }) });
  check(granted.status === 201, 'a project folder is granted, as Edit in folder');
  const grant = (await granted.json()).grants[0];

  for (let i = 0; i < 50 && !(await req('/devices', { jar: me })).json.find((d) => d.id === dev.id)?.grants.length; i++) await sleep(100);
  devs = (await req('/devices', { jar: me })).json;
  const seen = devs.find((d) => d.id === dev.id).grants[0];
  check(seen?.label === 'demo' && seen.usable, 'the server sees the grant by label');
  check(!JSON.stringify(devs).includes(home), '…and never its path');

  /* ---------------------------------------------------- Add my agent */

  const S = (await req('/sessions', { method: 'POST', body: { title: `Host ${stamp}` }, jar: me })).json;
  const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
  check((await req(`${base}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: 'not-a-grant' }, jar: me })).status === 400, 'a grant the device never reported is refused');
  check((await req(`${base}/agents/host`, { method: 'POST', body: { deviceId: '00000000-0000-0000-0000-000000000000', grantId: grant.id }, jar: me })).status === 404, "someone else's (or no) device is a 404");
  const bound = await req(`${base}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: grant.id }, jar: me });
  check(bound.status === 201, 'Add my agent binds it to the folder — no token, nothing copied');
  const agentName = bound.json.agent.displayName;
  const hosts = (await req(`${base}/agents/hosts`, { jar: me })).json;
  check(Object.values(hosts).some((h) => h.label === 'demo' && h.online), 'the session shows where the agent runs');

  let status;
  for (let i = 0; i < 80; i++) {
    status = (await req(base, { jar: me })).json.participants.find((p) => p.displayName === agentName)?.status;
    if (status === 'connected' || status === 'idle') break;
    await sleep(150);
  }
  check(status === 'connected' || status === 'idle', 'the host connects the agent as a runner, through the existing delivery path');
  const hostState = await (await local('/api/state')).json();
  check(hostState.agents.some((a) => a.agent === agentName && a.active), "the host's page lists the agent as ready");

  /* ------------------------------------------------------ real runs */

  if (SPAWN) {
    await req(`${base}/messages`, { method: 'POST', body: { content: `@${agentName} fix the spelling mistake in typo.txt — change only that word` }, jar: me });
    let fixed = false;
    for (let i = 0; i < 240 && !fixed; i++) {
      fixed = readFileSync(join(demo, 'typo.txt'), 'utf8').includes('the quick');
      if (!fixed) await sleep(500);
    }
    check(fixed, 'SPAWN: a mention edits the file inside the granted folder');
    let posted = false;
    for (let i = 0; i < 120 && !posted; i++) {
      posted = (await req(`${base}/messages`, { jar: me })).json.some((m) => m.author.displayName === agentName);
      if (!posted) await sleep(500);
    }
    check(posted, 'SPAWN: …and the agent posts its answer to the session');
    // The answer is posted during the run; wait for the run itself to end.
    let log = [];
    for (let i = 0; i < 240 && !log.some((e) => e.event === 'done'); i++) {
      log = (await (await local('/api/state')).json()).log;
      if (!log.some((e) => e.event === 'done')) await sleep(500);
    }
    check(log.some((e) => e.event === 'done' && e.policy === 'edit' && e.folder === 'demo'), "SPAWN: the host's log records the run, folder and policy");

    await local(`/api/grants/${grant.id}`, { method: 'POST', body: JSON.stringify({ policy: 'read' }) });
    writeFileSync(join(demo, 'typo.txt'), 'teh quick brown fox\n');
    await sleep(1500);
    await req(`${base}/messages`, { method: 'POST', body: { content: `@${agentName} fix the spelling mistake in typo.txt` }, jar: me });
    let ended = false;
    for (let i = 0; i < 240 && !ended; i++) {
      ended = (await (await local('/api/state')).json()).log.filter((e) => e.event !== 'started').length >= 2;
      if (!ended) await sleep(500);
    }
    check(ended && readFileSync(join(demo, 'typo.txt'), 'utf8').includes('teh quick'), 'SPAWN: switched to Read only on the machine, the same request changes nothing');
  } else {
    console.log('skip real runs (set FABRIKKA_TEST_SPAWN=1 to spawn claude)');
  }

  /* --------------------------------------------------------- revoke */

  check((await req(`/devices/${dev.id}`, { method: 'DELETE', jar: me })).status === 200, 'disconnecting the device on the web…');
  check(!!(await waitFor(/disconnected from Fabrikka/)), '…disconnects the host');
  let after;
  for (let i = 0; i < 50; i++) {
    after = (await req(base, { jar: me })).json.participants.find((p) => p.displayName === agentName)?.status;
    if (after === 'offline' || after === undefined) break;
    await sleep(150);
  }
  check(after === 'offline' || after === undefined, '…and its agent goes offline in the session');
  check(!JSON.parse(readFileSync(join(home, 'host.json'), 'utf8')).deviceToken, 'the host forgets its token');
} finally {
  cleanup();
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM31 checks passed');
process.exit(0);
