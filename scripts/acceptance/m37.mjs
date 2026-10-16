/**
 * M37 acceptance: the computer decides which agent tools it offers.
 *
 * One registry (AGENT_TOOLS) feeds the host, the server and the picker; a
 * computer's Agent tools switches decide what it reports; switching a tool off
 * stops its agents there and keeps it out of the picker; a tool that isn't
 * installed can't be switched on.
 *
 * Requires: the core server on :9090, the test account, the bridge built, and
 * every registry tool (Claude Code, Codex, OpenCode) installed on this machine.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const CORE = 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const CLI = 'packages/bridge/dist/cli.js';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
const api = (path, init = {}) => fetch(`${CORE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie } });

// Devices this run adds are the ones that weren't here when it started (by id, not by time).
const devicesBefore = new Set((await (await api('/devices')).json()).map((d) => d.id));

/** A paired host over stdio, in its own scratch home, with the given PATH. */
async function startHost(path) {
  const home = mkdtempSync(join(tmpdir(), 'm37-host-'));
  const child = spawn('node', [CLI, 'host', '--server', CORE, '--control', 'stdio'], {
    env: { ...process.env, FABRIKKA_HOST_HOME: home, ...(path ? { PATH: path } : {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let pair = null;
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.event === 'pair') pair = m;
      if (m.id != null && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
    } catch {}
  });
  let n = 0;
  const ask = (req) =>
    new Promise((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, ...req }) + '\n');
      setTimeout(() => pending.has(id) && (pending.delete(id), resolve({ ok: false, error: 'timeout' })), 8000);
    });
  for (let i = 0; i < 40 && !pair; i++) await sleep(250);
  await api('/devices/pair/confirm', { method: 'POST', body: JSON.stringify({ code: pair?.code }) });
  for (let i = 0; i < 40; i++) {
    if ((await ask({ op: 'state' })).state?.connected) break;
    await sleep(300);
  }
  return { child, ask, home, stop: () => (child.stdin.end(), rmSync(home, { recursive: true, force: true })) };
}

/* ------------------------------------------------ 1. one registry */

const read = (p) => readFileSync(p, 'utf8');
check(/export const AGENT_TOOLS: readonly AgentTool\[\] = \[/.test(read('packages/types/src/index.ts')), 'the agent tools are one registry, AGENT_TOOLS');
check(/HOST_PROVIDERS = AGENT_TOOLS\.map/.test(read('apps/server/src/devices.ts')), 'the server reads it');
check(/AGENT_TOOLS\.filter\(\(t\) => has\(t\.command\)\)/.test(read('packages/bridge/src/host/host.ts')), 'the host detects tools from it');
check(/agentTool\(p\)/.test(read('apps/web/src/pages/SessionPage.tsx')) && /<Select\s+label="Agent tool"/.test(read('apps/web/src/pages/SessionPage.tsx')), "the picker's Which agent? is the app's selector, filled from it");
// The registry's ids, in order, read from the one place they're declared.
const registryBlock = /AGENT_TOOLS: readonly AgentTool\[\] = \[([\s\S]*?)\n\];/.exec(read('packages/types/src/index.ts'))?.[1] ?? '';
const REGISTRY = [...registryBlock.matchAll(/\bid: '([a-z0-9-]+)'/g)].map((m) => m[1]);
check(REGISTRY.length >= 3 && REGISTRY.includes('opencode'), `the registry lists ${REGISTRY.join(', ')}`);
const hardcoded = ['apps/server/src/devices.ts', 'packages/bridge/src/host/host.ts', 'apps/web/src/pages/SessionPage.tsx'].filter((f) => /\[\s*'claude-code',\s*'codex'\s*\]/.test(read(f)));
check(hardcoded.length === 0, "NO OTHER HARD-CODED LIST OF TOOLS");

/* ------------------------------------------------ 2. the computer decides */

const project = mkdtempSync(join(tmpdir(), 'm37-project-'));
const host = await startHost();
let st = (await host.ask({ op: 'state' })).state;
check(st?.tools?.map((t) => t.id).join(',') === REGISTRY.join(',') && st.tools.every((t) => t.installed && t.enabled), 'Agent tools lists every registry tool: installed here, and offered by default');
// M53 (ADR 0051): a folder is for an organization; the room below is in your own.
const own = (await (await api('/teams')).json()).find((t) => t.own);
for (let i = 0; i < 40 && !(await host.ask({ op: 'state' })).state?.organizations?.some((o) => o.id === own.id); i++) await sleep(250);
const grant = (await host.ask({ op: 'grant', path: project, policy: 'edit', org: own.id })).grant;
const deviceFor = async () => (await (await api('/devices')).json()).find((d) => d.grants.some((g) => g.id === grant?.id));
let dev = null;
for (let i = 0; i < 20; i++) {
  dev = await deviceFor();
  if (dev?.grants.find((g) => g.id === grant.id)?.providers.includes('codex')) break;
  await sleep(250);
}
check(dev?.grants.find((g) => g.id === grant?.id)?.providers.join(',') === REGISTRY.join(','), 'the server sees every tool offered for the folder');

const S = await (await api('/sessions', { method: 'POST', body: JSON.stringify({ title: `M37 ${Date.now()}` }) })).json();
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const codexAgent = (await (await api(`${base}/agents/host`, { method: 'POST', body: JSON.stringify({ deviceId: dev.id, grantId: grant.id, provider: 'codex' }) })).json()).agent;
const agentActive = async () => (await host.ask({ op: 'state' })).state?.agents.find((a) => a.agent === codexAgent?.displayName)?.active;
for (let i = 0; i < 20 && !(await agentActive()); i++) await sleep(250);
check(await agentActive(), 'a Codex agent is bound and its runner is running');

check((await host.ask({ op: 'tool', tool: 'codex', enabled: false })).ok, 'SWITCHING CODEX OFF on this computer…');
let providers = '';
for (let i = 0; i < 20; i++) {
  providers = (await deviceFor())?.grants.find((g) => g.id === grant.id)?.providers.join(',');
  if (providers === REGISTRY.filter((t) => t !== 'codex').join(',')) break;
  await sleep(250);
}
check(providers === REGISTRY.filter((t) => t !== 'codex').join(','), '…makes the server see the other tools offered, and Codex gone from the picker');
check((await agentActive()) === false, "…stops the Codex agent that's already bound");
const refused = await api(`${base}/agents/host`, { method: 'POST', body: JSON.stringify({ deviceId: dev.id, grantId: grant.id, provider: 'codex' }) });
check(refused.status !== 201, '…and a new Codex agent cannot be added there');

check((await host.ask({ op: 'tool', tool: 'codex', enabled: true })).ok, 'switching it back on…');
for (let i = 0; i < 20 && !(await agentActive()); i++) await sleep(250);
check(await agentActive(), "…runs the Codex agent again");
check(JSON.parse(readFileSync(join(host.home, 'host.json'), 'utf8')).tools?.codex === true, "the choice is kept in this computer's own config, not on the server");
check((await host.ask({ op: 'tool', tool: 'cursor', enabled: true })).error === 'no such agent tool', 'an unknown tool is refused');

/* ------------------------------------------------ 3. not installed */

const bare = await startHost(['/usr/bin', '/bin', dirname(process.execPath)].join(':'));
const bareState = (await bare.ask({ op: 'state' })).state;
check(bareState?.tools?.every((t) => !t.installed && !t.enabled), 'with no tool on the PATH, all show as not installed and not offered');
check(/not installed/.test((await bare.ask({ op: 'tool', tool: 'claude-code', enabled: true })).error ?? ''), 'A TOOL THAT ISN\'T INSTALLED CANNOT BE SWITCHED ON');
bare.stop();

/* ----------------------------------------------------------------- cleanup */

host.stop();
await sleep(500);
await api(base, { method: 'DELETE' });
for (const d of await (await api('/devices')).json()) {
  if (!devicesBefore.has(d.id)) await api(`/devices/${d.id}`, { method: 'DELETE' });
}
rmSync(project, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM37 checks passed');
process.exit(0);
