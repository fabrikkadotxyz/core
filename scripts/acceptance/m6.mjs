/**
 * M6 acceptance: the turn budget and the kill switch.
 *
 * The properties from ADR 0012 — halting delivery is ABSOLUTE and server-side,
 * while aborting a run in flight is a cooperative request. The distinction is
 * tested, not just documented.
 *
 * The real mid-run kill (which spawns an actual agent) is gated behind
 * FABRIKKA_TEST_SPAWN=1, like M5's.
 *
 * Requires: server on :9090 and an account.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const API = 'http://localhost:9090/api';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'fede@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const DEEP = process.env.FABRIKKA_TEST_SPAWN === '1';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));
const skip = (m) => console.log('skip', m);

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

function admin(args, stdinValue) {
  return new Promise((resolve, reject) => {
    const child = execFileCb('pnpm', ['admin', ...args], (e, o) =>
      e ? reject(e) : resolve(o),
    );
    child.stdin.end(stdinValue ?? '');
  });
}

function openConnection(url, token, kind) {
  const frames = [];
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const state = { frames, ws };
  ws.on('message', (d) => {
    const f = JSON.parse(String(d));
    frames.push(f);
    if (f.type === 'ready' && kind) ws.send(JSON.stringify({ type: 'hello', kind }));
  });
  ws.on('error', () => {});
  state.waitFor = async (type, ms = 2500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = frames.find((f) => f.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  state.mentions = () => frames.filter((f) => f.type === 'mention');
  return state;
}

const stamp = Date.now();

/* ------------------------------------------------------------------ setup */

const fede = jar();
if (
  (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede }))
    .status !== 200
) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

const S = (
  await req('/sessions', { method: 'POST', body: { title: `Rails ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const wsUrl = `ws://localhost:9090/bridge/o/${S.ownerSlug}/s/${S.publicId}`;

const agent = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'rails-a', provider: 'claude-code' },
    jar: fede,
  })
).json;

const conn = openConnection(wsUrl, agent.token, 'bridge');
await conn.waitFor('ready');
await new Promise((r) => setTimeout(r, 300));

/* ---------------------------------------- 1. the kill switch */

const initial = await req(`${base}/pause`, { jar: fede });
check(initial.json.paused === false, 'a new session starts with agents active');
check(initial.json.turnLimit > 0, 'the turn limit is reported to clients');

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@rails-a before pause ${stamp}` },
  jar: fede,
});
check(!!(await conn.waitFor('mention')), 'delivery works before pausing');

const paused = await req(`${base}/pause`, { method: 'POST', jar: fede });
check(paused.json.paused === true, 'the kill switch pauses the session');
check(paused.json.reason === 'manual', 'a human pause is recorded as manual');

const abort = await conn.waitFor('abort');
check(!!abort, 'connections are ASKED to abort in-flight work');

const before = conn.mentions().length;
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@rails-a while paused ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 900));
check(
  conn.mentions().length === before,
  'WHILE PAUSED NO WORK IS SENT — the halt is absolute and server-side',
);

const viewPaused = await req(base, { jar: fede });
check(
  viewPaused.json.agents.paused === true && viewPaused.json.agents.reason === 'manual',
  'the session view reports the pause and its cause',
);

/* ------------------------------ 2. blocked mentions stay visible */

const alerts = [];
const stream = new WebSocket(
  `ws://localhost:9090/api/o/${S.ownerSlug}/s/${S.publicId}/stream`,
  { headers: { cookie: fede.headers.cookie } },
);
stream.on('message', (d) => alerts.push(JSON.parse(String(d))));
await new Promise((r) => setTimeout(r, 400));

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@rails-a still paused ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 900));
check(
  alerts.find((a) => a.type === 'mention.blocked')?.reason === 'paused',
  'a mention during a pause is reported as blocked, not silently dropped',
);

/* ----------------------------------------------- 3. resume */

const resumed = await req(`${base}/pause`, { method: 'DELETE', jar: fede });
check(resumed.json.paused === false, 'resuming clears the pause');
check(resumed.json.turnsUsed === 0, 'resuming starts a fresh budget window');

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@rails-a after resume ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 900));
check(
  conn.mentions().some((m) => m.message.content.includes(`after resume ${stamp}`)),
  'delivery works again after resuming',
);

/* -------------------------------------- 4. the turn budget */

const limit = resumed.json.turnLimit;
for (let i = 0; i < limit + 3; i++) {
  await req(`${base}/messages`, {
    method: 'POST',
    body: { content: `@rails-a burn ${i} ${stamp}` },
    jar: fede,
  });
}
await new Promise((r) => setTimeout(r, 1500));

const afterBurn = await req(`${base}/pause`, { jar: fede });
check(
  afterBurn.json.paused === true,
  'EXHAUSTING THE TURN BUDGET PAUSES THE SESSION — the loop guard',
);
check(
  afterBurn.json.reason === 'turn_budget',
  'the cause is recorded as turn_budget, distinct from a human pause',
);
check(
  alerts.some((a) => a.type === 'agents.paused' && a.reason === 'turn_budget'),
  'the automatic pause is announced, not silent',
);

const delivered = conn.mentions().length;
check(
  delivered <= limit + 2,
  `delivery stopped near the limit (${delivered} delivered, limit ${limit})`,
);

await req(`${base}/pause`, { method: 'DELETE', jar: fede });

/* ------------------- 5. any member can pull the switch */

const aliceEmail = `alice-m6-${stamp}@example.com`;
const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: { token: inv.json.token, email: aliceEmail, password: PASSWORD, displayName: 'alice' },
  jar: alice,
});

const byAlice = await req(`${base}/pause`, { method: 'POST', jar: alice });
check(
  byAlice.status === 200 && byAlice.json.paused === true,
  'ANY MEMBER can hit the kill switch — waiting for the owner is the wrong failure',
);
await req(`${base}/pause`, { method: 'DELETE', jar: fede });

const carolEmail = `carol-m6-${stamp}@example.com`;
await admin(['create-user', '--email', carolEmail, '--name', 'carol', '--password-stdin'], PASSWORD);
const carol = jar();
await req('/auth/login', { method: 'POST', body: { email: carolEmail, password: PASSWORD }, jar: carol });
const byCarol = await req(`${base}/pause`, { method: 'POST', jar: carol });
check(byCarol.status === 404, 'a non-member cannot pause the session (404)');

stream.close();

/* ------------------- 6. killing a real run (opt-in) */

if (!DEEP) {
  skip('mid-run kill — set FABRIKKA_TEST_SPAWN=1 to spawn a real agent and stop it');
} else {
  const runnerAgent = (
    await req(`${base}/agents`, {
      method: 'POST',
      body: { displayName: 'rails-run', provider: 'claude-code' },
      jar: fede,
    })
  ).json;

  const dir = await mkdtemp(join(tmpdir(), 'm6-kill-'));
  await writeFile(join(dir, 'NOTES.md'), 'nothing interesting\n');

  const child = spawn(
    'node',
    ['packages/bridge/dist/cli.js', 'watch', '--dir', dir],
    {
      env: {
        ...process.env,
        FABRIKKA_URL: `http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`,
        FABRIKKA_TOKEN: runnerAgent.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));
  await new Promise((r) => setTimeout(r, 4000));

  await req(`${base}/messages`, {
    method: 'POST',
    body: {
      content: `@rails-run count slowly from 1 to 40, thinking carefully about each number`,
    },
    jar: fede,
  });

  // Wait for the run to actually start before stopping it.
  const started = Date.now() + 60_000;
  while (Date.now() < started && !/run start/.test(log)) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check(/run start/.test(log), 'a run started');

  await new Promise((r) => setTimeout(r, 3000));
  await req(`${base}/pause`, { method: 'POST', jar: fede });

  // Wait for the LAST marker, not the first: "abort requested" appears the moment
  // the frame arrives, while "run stopped" appears once the child is actually
  // dead. Waiting on either raced the child's death and failed spuriously.
  const stopped = Date.now() + 30_000;
  while (Date.now() < stopped && !/run stopped/.test(log)) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check(/abort requested/.test(log), 'THE RUNNER STOPPED ITS CHILD when asked');
  check(
    /run stopped/.test(log),
    'the stopped run reports being stopped, not failed — a human asked for it',
  );

  // And the post that follows it.
  await new Promise((r) => setTimeout(r, 1500));
  const msgs = (await req(`${base}/messages`, { jar: fede })).json;
  check(
    msgs.some((m) => m.author.displayName === 'rails-run' && /stopped/i.test(m.content)),
    'the stop is visible in the timeline',
  );

  child.kill();
  await rm(dir, { recursive: true, force: true });
  await req(`${base}/pause`, { method: 'DELETE', jar: fede });
}

/* ----------------------------------------------------- cleanup */

conn.ws.close();
await req(base, { method: 'DELETE', jar: fede });
for (const e of [aliceEmail, carolEmail]) {
  await admin(['delete-user', '--email', e]).catch(() => {});
}

console.log(
  failures === 0 ? '\nM6 acceptance: PASS' : `\nM6 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
