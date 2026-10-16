/**
 * ADR 0054 acceptance: the reporting contract (herdr item 3).
 *
 * Over HTTP with a real run token: a state report shows on the participant
 * (blocked, with why); a resume report is kept only when it passes the argv
 * rules, and the run shows its first word; a release ends the run; unknown
 * kinds and values are ignored with 202; a run the token does not own is a
 * 404; the sixty-a-minute limit holds. Through the real client: `fabrikka
 * report` posts from the environment and exits 0 even with nothing set, and
 * `fabrikka run -- sh -c …` answers a mention with the command's output.
 * Setup offers the Any command lane.
 *
 * Requires: the core server on :9090, the test account, the bridge built.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const CORE = 'http://localhost:9090';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, { method = 'GET', body, cookie, bearer, raw } = {}) {
  const r = await fetch(path.startsWith('http') ? path : `${CORE}/api${path}`, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), connection: 'close' },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  return { status: r.status, json, cookie: set ? set.split(';')[0] : undefined };
}

/* ------------------------------------------------ 1. the source */

check(/## 4\. Reporting contract/.test(read('docs/protocol.md')) && /FABRIKKA_REPORT_URL/.test(read('docs/protocol.md')), 'docs/protocol.md has section 4, the reporting contract');
check(/FABRIKKA_REPORT_URL: req\.report\.url/.test(read('packages/bridge/src/spawn.ts')), 'EVERY SPAWNED RUN GETS THE REPORT VARIABLES');
check(/command === 'report'/.test(read('packages/bridge/src/cli.ts')) && /command === 'run'/.test(read('packages/bridge/src/cli.ts')), 'the client has fabrikka report and fabrikka run');
check(/commandCommand/.test(read('apps/server/src/app.ts')) && /'command'/.test(read('packages/types/src/index.ts')), 'Setup offers the Any command lane');
check(/Reports from a run \(ADR 0054\)/.test(read('docs/security.md')), 'docs/security.md says reports are untrusted input, with the boundary');

/* ------------------------------------------------ 2. over HTTP, with a run token */

const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const S = (await req('/sessions', { method: 'POST', body: { title: `Report ${stamp}` }, cookie: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `reporter-${stamp}`, provider: 'other' }, cookie: fede })).json;
const other = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `bystander-${stamp}`, provider: 'other' }, cookie: fede })).json;
const bridgeBase = `${CORE}/bridge${base}`;
const minted = await req(`${bridgeBase}/run-token`, { method: 'POST', bearer: agent.token, body: {} });
check(minted.status === 201 && minted.json.token, 'a run token is minted, as the runner does');
const runToken = minted.json.token;
const REPORT = `${bridgeBase}/report`;
const report = (body, bearer = runToken) => req(REPORT, { method: 'POST', bearer, body });

// A run must exist and be the token's own: open one over the socket, as a runner would.
const frames = [];
const ws = new WebSocket(`ws://localhost:9090/bridge${base}`, { headers: { Authorization: `Bearer ${agent.token}` } });
ws.on('message', (d) => { const f = JSON.parse(String(d)); frames.push(f); if (f.type === 'ready') ws.send(JSON.stringify({ type: 'hello', kind: 'runner' })); });
ws.on('error', () => {});
for (let i = 0; i < 40 && !frames.some((f) => f.type === 'ready'); i++) await sleep(100);
const runId = randomUUID();
ws.send(JSON.stringify({ type: 'run.start', runId, kind: 'spawn', provider: 'other', seq: 1 }));
await sleep(300);
const me = () => req(base, { cookie: fede }).then((r) => r.json.participants.find((p) => p.displayName === `reporter-${stamp}`));

let r = await report({ report: 'state', runId, status: 'blocked', reason: 'elicitation', detail: 'which branch?' });
check(r.status === 202 && r.json.ok === true, 'A STATE REPORT IS TAKEN (202)');
let p = await me();
check(p?.status === 'blocked' && p.blocked?.reason === 'elicitation' && p.blocked?.detail === 'which branch?', '…and shows on the participant, with why');
r = await report({ report: 'state', runId, status: 'dancing' });
check(r.status === 202 && r.json.ok === false && r.json.ignored === 'status', 'an unknown status is ignored, still 202 (compatibility rules)');
r = await report({ report: 'feelings', runId });
check(r.status === 202 && r.json.ignored === 'report', 'an unknown report kind is ignored, still 202');
r = await report({ report: 'state', runId: randomUUID(), status: 'working' });
check(r.status === 404, 'A RUN THE TOKEN DOES NOT OWN IS A 404');
r = await req(REPORT, { method: 'POST', body: { report: 'state', runId, status: 'working' } });
check(r.status === 401, 'no token: 401');
r = await req(REPORT, { method: 'POST', bearer: runToken, raw: 'x'.repeat(17 * 1024) });
check(r.status === 413, 'past 16 KiB: 413');

// Resume: the argv rules (herdr item 5).
r = await report({ report: 'resume', runId, argv: ['claude', '--resume', 'abc123'] });
check(r.status === 202 && r.json.ok === true, 'A VALID RESUME ARGV IS KEPT');
check(/resumeWith: row\.resumeArgv\?\.\[0\] \?\? null/.test(read('apps/server/src/activity.ts')), '…and a run shows only its first word, never the argv (source)');
for (const [argv, why] of [
  [['/usr/bin/claude', '--resume', 'x'], 'a path as the first word'],
  [['claude', "it's"], 'an apostrophe'],
  [['claude', 'a\u0007b'], 'a control character'],
  [Array.from({ length: 65 }, () => 'a'), 'more than 64 arguments'],
  [['claude', 'x'.repeat(9000)], 'more than 8 KiB'],
  [[], 'nothing'],
  ['claude --resume x', 'a string instead of a list'],
]) {
  r = await report({ report: 'resume', runId, argv });
  check(r.status === 202 && r.json.ok === false && r.json.ignored === 'argv', `a resume argv with ${why} is ignored`);
}

// Release ends the run.
r = await report({ report: 'release', runId, status: 'done' });
check(r.status === 202 && r.json.ok === true, 'A RELEASE REPORT ENDS THE RUN');
await sleep(300);
const home = (await req('/me/home', { cookie: fede })).json;
check(!home.running.some((x) => x.id === runId), '…and it is no longer running on the home');
r = await report({ report: 'state', runId, status: 'working' }, other.token);
check(r.status === 404, "another agent's token cannot report on this run");

// The limit: sixty a minute per run.
const runId2 = randomUUID();
ws.send(JSON.stringify({ type: 'run.start', runId: runId2, kind: 'spawn', provider: 'other', seq: 2 }));
await sleep(300);
let limited = 0;
for (let i = 0; i < 65; i++) {
  const x = await report({ report: 'state', runId: runId2, status: 'working' });
  if (x.status === 429) limited++;
}
check(limited > 0, 'PAST SIXTY REPORTS A MINUTE ON ONE RUN: 429');
ws.close();

/* ------------------------------------------------ 3. through the real client */

const CLI = 'packages/bridge/dist/cli.js';
const out = execFileSync(process.execPath, [CLI, 'report', 'state', 'working'], { env: { ...process.env, FABRIKKA_REPORT_URL: '', FABRIKKA_RUN_TOKEN: '', FABRIKKA_RUN_ID: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
check(true, `fabrikka report with nothing set exits 0 and says so (${out.trim().slice(0, 40) || 'quietly'})`);

// Any command as an agent: a shell command answers a mention with its stdout.
const cmdAgent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `shell-${stamp}`, provider: 'other' }, cookie: fede })).json;
check(cmdAgent.setup?.lanes?.includes('command') && / run --dir \. -- <your command>/.test(cmdAgent.setup?.commandCommand ?? ''), 'SETUP OFFERS THE ANY COMMAND LANE for an unknown provider, with the line to run');
const mcpUrl = cmdAgent.mcpUrl;
const runner = spawn(process.execPath, [CLI, 'run', '--dir', process.cwd(), '--', 'sh', '-c', 'cat >/dev/null; echo "hello from the shell $FABRIKKA_RUN_ID"'], {
  env: { ...process.env, FABRIKKA_URL: mcpUrl, FABRIKKA_TOKEN: cmdAgent.token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const lines = [];
runner.stderr.on('data', (d) => lines.push(...String(d).split('\n')));
await sleep(1500);
await req(`${base}/messages`, { method: 'POST', body: { content: `@shell-${stamp} say hello` }, cookie: fede });
let answered = null;
for (let i = 0; i < 60 && !answered; i++) {
  await sleep(500);
  const msgs = (await req(`${base}/messages`, { cookie: fede })).json;
  answered = (Array.isArray(msgs) ? msgs : msgs?.messages ?? []).find((m) => /hello from the shell/.test(m.content ?? ''));
}
check(!!answered, 'ANY COMMAND AS AN AGENT: a mention runs it with the prompt on stdin and its stdout is posted');
check(/hello from the shell [0-9a-f-]{36}/.test(answered?.content ?? ''), '…with FABRIKKA_RUN_ID set in its environment');
runner.kill('SIGTERM');

console.log(failures ? `\n${failures} FAILED` : '\nADR 0054 checks passed');
process.exit(failures ? 1 : 0);
