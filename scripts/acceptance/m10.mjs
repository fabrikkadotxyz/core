/**
 * M10 acceptance: live activity.
 *
 * The properties from ADR 0015, in the order they can hurt if wrong:
 *
 *   1. Activity is INERT — it never reaches another agent as a mention, never
 *      consumes turn budget, and never becomes a message. If this breaks,
 *      "show me what the agent is doing" has quietly become an injection path
 *      between agents.
 *   2. Activity is SCOPED — a runner can only describe its own run, and only
 *      in its own session.
 *   3. Activity is OPTIONAL — its owner can turn the stream off and keep
 *      working, and only its owner can flip that switch.
 *   4. Activity CATCHES UP — a tab opened mid-run sees the run and its recent
 *      steps, because a live feed nobody can join late is not live.
 *
 * Redaction is unit-tested where it runs (packages/bridge, `pnpm test`); what
 * is checked here is that the server treats `detail` as already-redacted
 * display text and bounds it anyway.
 *
 * Requires: server on :9090 and an account.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const API = 'http://localhost:9090/api';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'fede@example.com';
const DEEP = process.env.FABRIKKA_TEST_SPAWN === '1';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));
const skip = (m) => console.log('skip', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** A bridge/runner connection: the end that PRODUCES activity. */
function runner(wsUrl, token, kind = 'runner') {
  const frames = [];
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
  ws.on('message', (d) => {
    const f = JSON.parse(String(d));
    frames.push(f);
    if (f.type === 'ready') ws.send(JSON.stringify({ type: 'hello', kind }));
  });
  ws.on('error', () => {});
  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: async (type, ms = 2500) => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = frames.find((f) => f.type === type);
        if (hit || Date.now() > end) return hit ?? null;
        await sleep(50);
      }
    },
    close: () => ws.close(),
  };
}

/** A browser stream: the end that CONSUMES activity. */
function viewer(base, j) {
  const frames = [];
  const url = `ws://localhost:9090/api${base}/stream`;
  const ws = new WebSocket(url, { headers: j.headers });
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  return {
    frames,
    of: (type) => frames.filter((f) => f.type === type),
    waitFor: async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = frames.find(pred);
        if (hit || Date.now() > end) return hit ?? null;
        await sleep(50);
      }
    },
    close: () => ws.close(),
  };
}

const stamp = Date.now();

/* ------------------------------------------------------------------ setup */

const fede = jar();
if (
  (
    await req('/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
      jar: fede,
    })
  ).status !== 200
) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

const S = (
  await req('/sessions', { method: 'POST', body: { title: `Activity ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const wsUrl = `ws://localhost:9090/bridge/o/${S.ownerSlug}/s/${S.publicId}`;

const watcher = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: `act-watcher-${stamp}`, provider: 'claude-code' },
    jar: fede,
  })
).json;

const listener = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: `act-listener-${stamp}`, provider: 'claude-code' },
    jar: fede,
  })
).json;

const agentsBefore = (await req(`${base}/agents`, { jar: fede })).json;
check(
  agentsBefore.every((a) => a.activityVisible === true),
  'a new agent streams its steps by default',
);

const conn = runner(wsUrl, watcher.token);
const other = runner(wsUrl, listener.token);
await conn.waitFor('ready');
await other.waitFor('ready');
await sleep(300);

const view = viewer(base, fede);
await sleep(300);

/* -------------------------------------------------- 1. the run, end to end */

const runId = `11111111-1111-4111-8111-${String(stamp).slice(-12).padStart(12, '0')}`;

conn.send({ type: 'run.start', runId, kind: 'spawn', provider: 'claude-code' });
const started = await view.waitFor((f) => f.type === 'run.started' && f.run.id === runId);
check(!!started, 'run.start from a runner reaches the browser as run.started');
check(started?.run.status === 'running', 'the run arrives marked running');
check(started?.run.kind === 'spawn', 'the run carries how it was woken');
check(
  started?.run.displayName === watcher.agent.displayName,
  'the run is attributed to the agent, not to a raw id',
);

conn.send({ type: 'activity', runId, tool: 'Bash', detail: 'curl' });
const act = await view.waitFor((f) => f.type === 'activity' && f.event.tool === 'Bash');
check(!!act, 'an activity frame reaches the browser');
check(act?.event.runId === runId, 'the step says which run it belongs to');
check(act?.event.detail === 'curl', 'the redacted detail is passed through unchanged');
check(typeof act?.event.at === 'string', 'the step is timestamped for interleaving');

/* Ordering is the whole point of a live feed. */
conn.send({ type: 'activity', runId, tool: 'Read', detail: 'src/limits.ts' });
conn.send({ type: 'activity', runId, tool: 'mcp__fabrikka__post_message', detail: null });
await sleep(400);
const tools = view.of('activity').map((f) => f.event.tool);
check(
  tools.join(',').includes('Bash,Read,mcp__fabrikka__post_message'),
  'steps arrive in the order they happened',
);
check(
  view.of('activity').some((f) => f.event.detail === null),
  'a step with nothing safe to show carries a null detail, not a guess',
);

/* -------------------------------------------------------- 2. it is scoped */

other.send({ type: 'activity', runId, tool: 'StolenStep', detail: 'not mine' });
conn.send({ type: 'activity', runId, tool: 'FenceMarker', detail: null });
await view.waitFor((f) => f.type === 'activity' && f.event.tool === 'FenceMarker');
check(
  !view.of('activity').some((f) => f.event.tool === 'StolenStep'),
  "another participant cannot post steps into someone else's run",
);

other.send({ type: 'run.end', runId, status: 'failed' });
conn.send({ type: 'activity', runId, tool: 'StillAlive', detail: null });
await view.waitFor((f) => f.type === 'activity' && f.event.tool === 'StillAlive');
check(
  !view.of('run.ended').some((f) => f.run.id === runId),
  "another participant cannot end someone else's run",
);

const ghost = `22222222-2222-4222-8222-${String(stamp).slice(-12).padStart(12, '0')}`;
conn.send({ type: 'activity', runId: ghost, tool: 'GhostStep', detail: null });
await sleep(300);
check(
  !view.of('activity').some((f) => f.event.tool === 'GhostStep'),
  'a step for a run that was never started is dropped',
);

/* --------------------------------------------- 3. it is inert */

check(
  other.frames.filter((f) => f.type === 'mention').length === 0,
  'activity is never delivered to another agent as a mention',
);
check(
  conn.frames.filter((f) => f.type === 'mention').length === 0,
  'activity is never echoed back to the agent that produced it',
);

const pause = (await req(`${base}/pause`, { jar: fede })).json;
check(
  pause.turnsUsed === 0,
  'activity does not consume turn budget (a chatty agent cannot starve itself)',
);
check(pause.paused === false, 'a burst of activity does not trip the kill switch');

const messages = (await req(`${base}/messages`, { jar: fede })).json;
check(
  messages.length === 0,
  'activity never becomes a message — the durable record is what the agent posts',
);

/* ------------------------------------------------- 4. a late joiner catches up */

const late = viewer(base, fede);
const hello = await late.waitFor((f) => f.type === 'hello');
check(!!hello, 'a new stream gets a hello');
check(
  (hello?.runs ?? []).some((r) => r.id === runId),
  'a tab opened mid-run sees the run in flight',
);
check(
  (hello?.activity ?? []).some((a) => a.tool === 'Read'),
  'a tab opened mid-run sees the steps it missed',
);
late.close();

/* ------------------------------------------------------- 5. bounded detail */

conn.send({ type: 'activity', runId, tool: 'X'.repeat(200), detail: 'y'.repeat(500) });
const huge = await view.waitFor((f) => f.type === 'activity' && f.event.tool.startsWith('XX'));
check(!!huge && huge.event.tool.length <= 64, 'an oversized tool name is truncated');
check(!!huge && huge.event.detail.length <= 120, 'an oversized detail is truncated');

/* ----------------------------------------------------- 6. it is optional */

const off = await req(`${base}/agents/${watcher.agent.sessionAgentId}/activity`, {
  method: 'PATCH',
  body: { visible: false },
  jar: fede,
});
check(off.status === 200, "an agent's owner can turn its step stream off");

conn.send({ type: 'activity', runId, tool: 'AfterOptOut', detail: null });
await sleep(400);
check(
  !view.of('activity').some((f) => f.event.tool === 'AfterOptOut'),
  'with the stream off, no further steps are published',
);

const quiet = `33333333-3333-4333-8333-${String(stamp).slice(-12).padStart(12, '0')}`;
conn.send({ type: 'run.start', runId: quiet, kind: 'spawn', provider: 'claude-code' });
const quietRun = await view.waitFor((f) => f.type === 'run.started' && f.run.id === quiet);
check(
  !!quietRun,
  'with the stream off the RUN is still visible — presence is not the same as steps',
);

const bad1 = await req(`${base}/agents/${watcher.agent.sessionAgentId}/activity`, {
  method: 'PATCH',
  body: { visible: 'yes' },
  jar: fede,
});
check(bad1.status === 400, 'a non-boolean visibility is refused');

/* A second member, so the check is "not your agent", not "not a member". */
const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: {
    token: inv.json.token,
    email: `alice-m10-${stamp}@example.com`,
    password: 'password123',
    displayName: `alice-m10-${stamp}`,
  },
  jar: alice,
});

const theirs = await req(`${base}/agents/${watcher.agent.sessionAgentId}/activity`, {
  method: 'PATCH',
  body: { visible: true },
  jar: alice,
});
check(
  theirs.status === 404,
  "a member cannot flip someone else's agent's step stream (404, not 403)",
);

/* And the switch really is still off, i.e. the refusal was not a write. */
conn.send({ type: 'activity', runId, tool: 'AfterRefusedFlip', detail: null });
await sleep(400);
check(
  !view.of('activity').some((f) => f.event.tool === 'AfterRefusedFlip'),
  'the refused flip did not turn the stream back on',
);

/* ------------------------------------------------------------ 7. the end */

conn.send({ type: 'run.end', runId, status: 'done' });
const ended = await view.waitFor((f) => f.type === 'run.ended' && f.run.id === runId);
check(!!ended, 'run.end reaches the browser');
check(ended?.run.status === 'done', 'the run ends with its outcome');
check(typeof ended?.run.endedAt === 'string', 'an ended run carries when it ended');

/* The buffer is dropped with the run: catch-up is for what is happening now. */
const after = viewer(base, fede);
const helloAfter = await after.waitFor((f) => f.type === 'hello');
check(
  !(helloAfter?.runs ?? []).some((r) => r.id === runId),
  'an ended run drops out of catch-up',
);
check(
  !(helloAfter?.activity ?? []).some((a) => a.runId === runId),
  'an ended run leaves no buffered steps behind',
);
after.close();

conn.send({ type: 'run.end', runId: quiet, status: 'done' });
await sleep(200);

/* --------------------------------------- 8. a real run, streamed as it happens */

/**
 * The property that broke when this was first built: the runner buffered the
 * agent's stdout and parsed it on exit, so every step arrived AFTER the answer.
 * It looked correct in a screenshot and was useless in practice. So what is
 * asserted here is not "activity exists" but "activity arrived BEFORE the
 * agent's message" — liveness, not presence.
 */
if (!DEEP) {
  skip('live activity from a real run — set FABRIKKA_TEST_SPAWN=1');
} else {
  const dir = await mkdtemp(join(tmpdir(), 'm10-activity-'));
  await writeFile(join(dir, 'ANSWER.txt'), `the magic number is ${stamp}\n`);

  const spawned = (
    await req(`${base}/agents`, {
      method: 'POST',
      body: { displayName: `act-spawn-${stamp}`, provider: 'claude-code' },
      jar: fede,
    })
  ).json;

  const child = spawn('node', ['packages/bridge/dist/cli.js', 'watch', '--dir', dir], {
    env: {
      ...process.env,
      FABRIKKA_URL: `http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`,
      FABRIKKA_TOKEN: spawned.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const live = viewer(base, fede);
  await sleep(4000);

  await req(`${base}/messages`, {
    method: 'POST',
    body: {
      content: `@${spawned.agent.displayName} read ANSWER.txt and report the magic number`,
    },
    jar: fede,
  });

  const reply = await live.waitFor(
    (f) => f.type === 'message.created' && String(f.message.content).includes(String(stamp)),
    240_000,
  );
  check(!!reply, 'the spawned run answered');

  const steps = live.of('activity');
  check(steps.length > 0, 'a real run reports its steps');

  const firstStep = live.frames.findIndex((f) => f.type === 'activity');
  const answer = live.frames.findIndex(
    (f) => f.type === 'message.created' && String(f.message.content).includes(String(stamp)),
  );
  check(
    firstStep !== -1 && answer !== -1 && firstStep < answer,
    'steps arrive DURING the run, not replayed after the answer',
  );
  check(
    live.of('run.started').length > 0 && (await live.waitFor((f) => f.type === 'run.ended', 30_000)),
    'the run opens and closes around the work',
  );
  check(
    steps.every((f) => (f.event.detail ?? '').length <= 120),
    'no step leaks an unbounded argument',
  );
  check(
    !steps.some((f) => /sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{8,}/.test(f.event.detail ?? '')),
    'no step carries anything that looks like a credential',
  );

  live.close();
  child.kill('SIGTERM');
  await sleep(500);
}

view.close();
conn.close();
other.close();
await req(`${base}`, { method: 'DELETE', jar: fede });

console.log(
  failures === 0 ? '\nM10 acceptance: PASS' : `\nM10 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
