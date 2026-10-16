/**
 * M35 acceptance: Codex on the local host (ADR 0032).
 *
 * Always: each policy's Codex flags, the isolation and pre-approval in the
 * runner, the server binding a Codex agent from a granted folder (named
 * codex-<you>, run by the host), and the read caveat everywhere Codex is chosen.
 *
 * With FABRIKKA_TEST_SPAWN=1: real Codex runs through the runner's own
 * runAgent — exactly what the host runs — in a scratch project under the home
 * folder. Edit lands; writes outside, network and the user's own MCP servers
 * don't; Read only changes nothing; the answer reaches the session.
 *
 * Requires: the core server on :9090, the test account, the bridge built, Codex
 * installed (and signed in, for the gated runs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CORE = 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const CLI = 'packages/bridge/dist/cli.js';
const SPAWN = !!process.env.FABRIKKA_TEST_SPAWN;

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const harness = (...args) => {
  const r = spawnSync('npx', ['tsx', '../../scripts/fixtures/codex-run.mts', ...args], { cwd: 'apps/server', encoding: 'utf8', timeout: 300_000 });
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return { ok: false, error: r.stderr.slice(0, 300) };
  }
};

const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
// Codex runs take tens of seconds; meanwhile the server closes this client's idle
// keep-alive socket, and the next fetch can land on it and be reset. Retry once.
const api = (path, init = {}) => {
  const go = () => fetch(`${CORE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie } });
  return go().catch((err) => (err?.cause?.code === 'ECONNRESET' ? go() : Promise.reject(err)));
};
const me = (await (await api('/auth/me')).json()).user;

// Devices this run adds are the ones that weren't here when it started (by id, not by time).
const devicesBefore = new Set((await (await api('/devices')).json()).map((d) => d.id));

/* ------------------------------------------------ 1. the flags, as specified */

const args = harness('args');
const has = (list, ...seq) => list.join(' ').includes(seq.join(' '));
check(has(args.read, '-s', 'read-only') && has(args.read, '-c', 'approval_policy="never"'), 'Read only: Codex runs read-only, never asking');
check(has(args.edit, '-s', 'workspace-write') && has(args.edit, '-c', 'sandbox_workspace_write.network_access=false'), 'Edit in folder: workspace-write, NETWORK OFF');
check(['computer_use', 'browser_use', 'in_app_browser', 'apps', 'plugins'].every((f) => has(args.read, '--disable', f) && has(args.edit, '--disable', f)), "Codex's computer-use, browser, app and plugin features are switched off in both");
check(JSON.stringify(args.full) === '["--approve-for-me"]', 'Full is unchanged: --approve-for-me');
const spawnTs = readFileSync('packages/bridge/src/spawn.ts', 'utf8');
check(/policy === 'full' \? null : await isolatedCodexHome\(dir\)/.test(spawnTs) && /CODEX_HOME: codexHome/.test(spawnTs), 'READ AND EDIT RUN IN AN ISOLATED CODEX HOME: none of your own MCP servers, plugins or hooks');
check(/default_tools_approval_mode="approve"/.test(spawnTs) && /web_search="disabled"/.test(spawnTs), "only the session's own tools are pre-approved; web search is off");

/* ------------------------------------------------ 2. the host binds Codex */

const hostHome = mkdtempSync(join(tmpdir(), 'm35-host-'));
const project = join(homedir(), 'Library/Caches', `fabrikka-m35-${Date.now()}`);
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'typo.txt'), 'teh quick brown fox\n');
const host = spawn('node', [CLI, 'host', '--server', CORE, '--control', 'stdio'], { env: { ...process.env, FABRIKKA_HOST_HOME: hostHome }, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let pairEvent = null;
createInterface({ input: host.stdout }).on('line', (line) => {
  try {
    const m = JSON.parse(line);
    if (m.event === 'pair') pairEvent = m;
    if (m.id != null && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  } catch {}
});
let nextId = 0;
const ask = (req) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    host.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    setTimeout(() => pending.has(id) && (pending.delete(id), resolve({ ok: false })), 8000);
  });
for (let i = 0; i < 40 && !pairEvent; i++) await sleep(250);
await api('/devices/pair/confirm', { method: 'POST', body: JSON.stringify({ code: pairEvent?.code }) });
let st = null;
for (let i = 0; i < 40 && !st?.connected; i++) {
  st = (await ask({ op: 'state' })).state;
  await sleep(300);
}
// M53 (ADR 0051): a folder is for an organization; the room below is in your own.
const own = (await (await api('/teams')).json()).find((t) => t.own);
for (let i = 0; i < 40 && !(await ask({ op: 'state' })).state?.organizations?.some((o) => o.id === own.id); i++) await sleep(250);
const grant = (await ask({ op: 'grant', path: project, policy: 'edit', org: own.id })).grant;
check(st?.providers.includes('codex') && !!grant, 'the host reports Codex installed, and a folder is granted (Edit in folder)');

const S = (await (await api('/sessions', { method: 'POST', body: JSON.stringify({ title: `M35 ${Date.now()}` }) })).json());
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const dev = (await (await api('/devices')).json()).filter((d) => d.grants.some((g) => g.id === grant?.id))[0];
check(dev?.grants.find((g) => g.id === grant?.id)?.usable === true, 'the folder is offered for Add my agent');
const bound = await api(`${base}/agents/host`, { method: 'POST', body: JSON.stringify({ deviceId: dev?.id, grantId: grant?.id, provider: 'codex' }) });
const agent = await bound.json();
check(bound.status === 201 && agent.agent?.displayName?.startsWith(`codex-${me.displayName}`.replace(/[^A-Za-z0-9._-]+/g, '-')), 'A CODEX AGENT IS ADDED FROM THE FOLDER, as codex-<you> — nothing to paste');
let running = false;
for (let i = 0; i < 40 && !running; i++) {
  running = !!(await ask({ op: 'state' })).state?.agents.some((a) => a.agent === agent.agent?.displayName && a.active);
  await sleep(250);
}
check(running, 'the host starts a runner for it: Codex is no longer refused');
const claude = await api(`${base}/agents/host`, { method: 'POST', body: JSON.stringify({ deviceId: dev?.id, grantId: grant?.id, provider: 'claude-code' }) });
check(claude.status === 201 && (await claude.json()).agent?.displayName?.startsWith('claude-'), 'and Claude Code is still chosen the same way');

/* ------------------------------------------------ 3. said where it's chosen */

const caveat = /Codex can read files anywhere on this computer/;
// Since M37 the caveat is the registry's (AGENT_TOOLS), shown by the picker for whichever tool carries one.
check(caveat.test(readFileSync('packages/types/src/index.ts', 'utf8')) && /agentTool\(effectiveTool\)\?\.caveat/.test(readFileSync('apps/web/src/pages/SessionPage.tsx', 'utf8')), 'the picker states the read caveat when Codex is chosen');
check(/disabled=\{needsCaveatOk\}/.test(readFileSync('apps/web/src/pages/SessionPage.tsx', 'utf8')), '…and Add waits for the confirming tick');
check(/Codex agents can read files anywhere/.test(readFileSync('apps/desktop/src/folders.html', 'utf8')) && /Codex agents can read files anywhere/.test(readFileSync('packages/bridge/src/host/control.ts', 'utf8')), "the app's Folders window and the host's page say the same");

/* ------------------------------------------------ 4. real Codex runs */

if (SPAWN) {
  const word = `codex-m35-${Date.now()}`;
  // The host's agent token is per connection and stays with the host (binding
  // revokes the setup token), so this run posts as a plain Codex agent instead.
  const poster = await (await api(`${base}/agents`, { method: 'POST', body: JSON.stringify({ displayName: `codex-m35-${Date.now()}`, provider: 'codex' }) })).json();
  const mcp = { url: `${CORE}/mcp${base}`, token: poster.token };
  let r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, mcp, prompt: `Fix the spelling mistake in typo.txt (one word). Then use the post_message tool to post exactly: ${word}` }));
  check(readFileSync(join(project, 'typo.txt'), 'utf8').includes('the quick'), 'Edit: the file in its folder is fixed');
  const msgs = await (await api(`${base}/messages`)).json();
  check(msgs.some((m) => m.content.includes(word)), "…and Codex's answer reaches the session");

  r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, prompt: 'Run this shell command exactly: echo hello > ../m35-outside.txt' }));
  check(!existsSync(join(project, '..', 'm35-outside.txt')), 'Edit: it cannot write outside its folder');
  r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, prompt: 'Run this shell command exactly and show the output: curl -sS -m 10 https://example.com' }));
  check(!String(r.text).includes('Example Domain'), 'Edit: no network');
  r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, prompt: 'Use the node_repl or cua_repl tool to evaluate 1+1. If you have no such tool, say NO_SUCH_TOOL.' }));
  check(!r.tools.some((t) => /node_repl|cua_repl/.test(t)), "NONE OF YOUR OWN CODEX MCP SERVERS ARE AVAILABLE (node_repl, cua_repl)");

  writeFileSync(join(project, 'typo.txt'), 'teh quick brown fox\n');
  r = harness('run', JSON.stringify({ policy: 'read', cwd: project, prompt: 'Fix the spelling mistake in typo.txt. Also run: echo x > new.txt' }));
  check(readFileSync(join(project, 'typo.txt'), 'utf8').includes('teh quick') && !existsSync(join(project, 'new.txt')), 'Read only: nothing changes, even inside the folder');
} else {
  console.log('skip real Codex runs (set FABRIKKA_TEST_SPAWN=1; uses your Codex account)');
}

/* ----------------------------------------------------------------- cleanup */

host.stdin.end();
await sleep(500);
if (host.exitCode === null) host.kill();
await api(base, { method: 'DELETE' });
for (const d of await (await api('/devices')).json()) {
  if (!devicesBefore.has(d.id)) await api(`/devices/${d.id}`, { method: 'DELETE' });
}
rmSync(hostHome, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
rmSync(join(project, '..', 'm35-outside.txt'), { force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM35 checks passed');
process.exit(0);
