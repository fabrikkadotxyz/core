/**
 * M15 slice 1 acceptance: the `blocked` state and sequence numbers (herdr
 * items 1 and 2, docs/protocol.md "Bridge transport").
 *
 * Plays a bridge over the socket as an agent: a `blocked` frame with a reason
 * shows on the participant in the room's view and reaches the browser stream
 * with the reason; a numbered frame not above the last accepted is dropped,
 * so a stale `working` cannot undo an `idle`; an unnumbered frame still passes;
 * an `idle` with `completed` says so on the stream; the home's Running now
 * says the agent is blocked. From the source: the bridge numbers every frame
 * and restarts the counter per connection, and the protocol doc says so.
 *
 * Requires: the core server on :9090 and the test account.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

/* ------------------------------------------------ 1. the source */

const sock = read('packages/bridge/src/socket.ts');
check(/status: 'working' \| 'blocked' \| 'idle'/.test(sock) && /reason\?: 'permission' \| 'elicitation' \| 'input'/.test(sock), 'THE BRIDGE CAN SAY blocked, with why');
check(/\{ \.\.\.frame, seq: \+\+this\.seq \}/.test(sock) && /this\.seq = 0;/.test(sock), 'the bridge numbers every frame and restarts the counter per connection');
check(/status: 'idle', completed: true/.test(read('packages/bridge/src/watch.ts')), "the runner's idle after a run says completed");
const proto = read('docs/protocol.md');
check(/\*\*Sequence numbers\*\*/.test(proto) && /`blocked`/.test(proto) && /completed: true/.test(proto), 'docs/protocol.md specifies blocked, seq and completed');

/* ------------------------------------------------ 2. over the socket */

async function req(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(`${CORE}/api${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), connection: 'close' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  return { status: r.status, json, cookie: set ? set.split(';')[0] : undefined };
}
const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const S = (await req('/sessions', { method: 'POST', body: { title: `Blocked ${stamp}` }, cookie: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `blocky-${stamp}`, provider: 'claude-code' }, cookie: fede })).json;
const view = () => req(base, { cookie: fede }).then((r) => r.json);
const me = () => view().then((v) => v.participants.find((p) => p.displayName === `blocky-${stamp}`));

// The browser stream, to see presence events with their reason.
const events = [];
const stream = new WebSocket(`ws://localhost:9090/api${base}/stream`, { headers: { cookie: fede } });
stream.on('message', (d) => events.push(JSON.parse(String(d))));
stream.on('error', () => {});
const presence = (pred) => events.filter((e) => e.type === 'presence.updated' && pred(e));

// The bridge, as the agent.
const frames = [];
const ws = new WebSocket(`ws://localhost:9090/bridge${base}`, { headers: { Authorization: `Bearer ${agent.token}` } });
ws.on('message', (d) => { const f = JSON.parse(String(d)); frames.push(f); if (f.type === 'ready') ws.send(JSON.stringify({ type: 'hello', kind: 'runner' })); });
ws.on('error', () => {});
const send = (f) => ws.send(JSON.stringify(f));
for (let i = 0; i < 40 && !frames.some((f) => f.type === 'ready'); i++) await sleep(100);
await sleep(200);

const runId = randomUUID();
send({ type: 'run.start', runId, kind: 'spawn', provider: 'claude-code', seq: 1 });
send({ type: 'status', status: 'working', seq: 2 });
await sleep(300);
check((await me())?.status === 'working', 'a numbered working frame is accepted');

send({ type: 'status', status: 'blocked', reason: 'permission', detail: 'Bash', seq: 3 });
await sleep(300);
let p = await me();
check(p?.status === 'blocked' && p.blocked?.reason === 'permission' && p.blocked?.detail === 'Bash', "BLOCKED SHOWS ON THE PARTICIPANT, with why and on what");
check(presence((e) => e.status === 'blocked' && e.reason === 'permission' && e.detail === 'Bash').length > 0, '…and reaches the browser stream with the reason');
let home = (await req('/me/home', { cookie: fede })).json;
check(home.running.some((r) => r.id === runId && r.blocked?.reason === 'permission'), "THE HOME'S RUNNING NOW SAYS THE AGENT IS BLOCKED");

send({ type: 'status', status: 'idle', completed: true, seq: 5 });
await sleep(300);
p = await me();
check(p?.status === 'idle' && !p.blocked, 'idle clears blocked');
check(presence((e) => e.status === 'idle' && e.completed === true).length > 0, 'AN IDLE THAT ENDS WORK SAYS completed ON THE STREAM');

// A stale frame: numbered below the last accepted. Dropped, so idle stays.
send({ type: 'status', status: 'working', seq: 4 });
await sleep(300);
check((await me())?.status === 'idle', 'A STALE FRAME (seq 4 after 5) IS DROPPED: idle stays idle');
send({ type: 'status', status: 'working', seq: 5 });
await sleep(300);
check((await me())?.status === 'idle', 'a repeated sequence number is dropped too');
// An unnumbered frame (an older bridge) still passes.
send({ type: 'status', status: 'working' });
await sleep(300);
check((await me())?.status === 'working', 'an unnumbered frame is accepted, as before');
send({ type: 'status', status: 'blocked', reason: 'something-new', seq: 9 });
await sleep(300);
check((await me())?.status === 'blocked' && (await me())?.blocked?.reason === 'something-new', 'an unknown reason is kept and shown as waiting (unknown fallback)');
send({ type: 'run.end', runId, status: 'done', seq: 10 });
send({ type: 'status', status: 'idle', completed: true, seq: 11 });
await sleep(300);
ws.close();
stream.close();

console.log(failures ? `\n${failures} FAILED` : '\nM15 slice 1 checks passed');
process.exit(failures ? 1 : 0);
