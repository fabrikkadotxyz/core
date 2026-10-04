/**
 * M4 acceptance: the bridge socket and the delivery gate.
 *
 * The security-relevant property here is that **the server decides what an agent
 * may act on** — a channel push starts a turn, and the bridge runs on the user's
 * machine. See ADR 0010 and docs/security.md.
 *
 * Exercises the wire protocol directly rather than through Claude Code, which is
 * a manual test (docs/roadmap.md).
 *
 * Requires: server on :9090 and an account.
 * Run: node scripts/acceptance/m4.mjs
 */
import { execFile as execFileCb } from 'node:child_process';
import WebSocket from 'ws';

const API = 'http://localhost:9090/api';
const WS_BASE = 'ws://localhost:9090/bridge';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

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
    const child = execFileCb('pnpm', ['admin', ...args], (err, out) =>
      err ? reject(err) : resolve(out),
    );
    child.stdin.end(stdinValue ?? '');
  });
}

/** A bridge connection that records every frame it receives. */
function openBridge(url, token) {
  const frames = [];
  const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  const state = { frames, ws, httpStatus: null, closed: false };

  const ready = new Promise((resolve) => {
    ws.on('message', (d) => {
      frames.push(JSON.parse(String(d)));
      resolve(state);
    });
    ws.on('unexpected-response', (_r, res) => {
      state.httpStatus = res.statusCode;
      resolve(state);
    });
    ws.on('close', () => {
      state.closed = true;
      resolve(state);
    });
    ws.on('error', () => resolve(state));
    setTimeout(() => resolve(state), 2500);
  });

  state.ready = ready;
  state.waitFor = async (type, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = frames.find((f) => f.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  return state;
}

const stamp = Date.now();

/* ------------------------------------------------------------------ setup */

const fede = jar();
const login = await req('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: PASSWORD },
  jar: fede,
});
if (login.status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

const S = (
  await req('/sessions', { method: 'POST', body: { title: `Bridge ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const bridgeUrl = `${WS_BASE}/o/${S.ownerSlug}/s/${S.publicId}`;

const agent = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'claude-x', provider: 'claude-code' },
    jar: fede,
  })
).json;
const token = agent.token;

/* ----------------------------------------- 1. auth on the socket */

const noAuth = openBridge(bridgeUrl, null);
await noAuth.ready;
const noAuthErr = await noAuth.waitFor('error');
check(
  noAuthErr?.code === 'unauthenticated' || noAuth.httpStatus === 401,
  'a bridge socket with no token is refused',
);
noAuth.ws.close();

const badAuth = openBridge(bridgeUrl, 'not-a-real-token');
await badAuth.ready;
const badErr = await badAuth.waitFor('error');
check(badErr?.code === 'not_found', 'an invalid token is refused with not_found, not 403');
badAuth.ws.close();

// A human's token must not be able to hold a bridge: a push starts a turn.
const humanTokenRes = await req(`${base}/tokens`, {
  method: 'POST',
  body: { participantId: (await req(base, { jar: fede })).json.me.participantId },
  jar: fede,
});
const humanBridge = openBridge(bridgeUrl, humanTokenRes.json.token);
await humanBridge.ready;
const humanErr = await humanBridge.waitFor('error');
check(humanErr?.code === 'not_found', 'a human participant cannot hold a bridge connection');
humanBridge.ws.close();

/* --------------------------------------------- 2. the happy path */

const b = openBridge(bridgeUrl, token);
await b.ready;
const readyFrame = await b.waitFor('ready');
check(readyFrame?.participant?.display_name === 'claude-x', 'bridge receives a ready frame');
check(readyFrame?.session?.id === S.publicId, 'ready frame names the session');

const presence = await req(base, { jar: fede });
check(
  presence.json.participants.find((p) => p.displayName === 'claude-x')?.status ===
    'connected',
  'presence shows the agent as connected',
);

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@claude-x please look at this ${stamp}` },
  jar: fede,
});
const mention = await b.waitFor('mention');
check(!!mention, "the owner's mention is DELIVERED to the bridge");
check(mention?.trust === 'owner', 'the delivered mention carries trust=owner');
check(
  mention?.message.content.includes('@claude-x') &&
    !mention?.message.content.includes('<@'),
  'markers are expanded before delivery — the model never sees internal ids',
);

/* ------------------------------ 3. gating: mention required */

const before = b.frames.filter((f) => f.type === 'mention').length;
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `just talking to myself ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 600));
check(
  b.frames.filter((f) => f.type === 'mention').length === before,
  'an unmentioned message is NOT delivered — no ambient timeline consumption',
);

/* ---------------------- 4. gating: owner_only blocks a member */

const aliceEmail = `alice-m4-${stamp}@example.com`;
const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: { token: inv.json.token, email: aliceEmail, password: PASSWORD, displayName: 'alice' },
  jar: alice,
});

const beforeAlice = b.frames.filter((f) => f.type === 'mention').length;
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@claude-x rm -rf /tmp/demo ${stamp}` },
  jar: alice,
});
await new Promise((r) => setTimeout(r, 800));
check(
  b.frames.filter((f) => f.type === 'mention').length === beforeAlice,
  "ALICE CANNOT DRIVE FEDE'S AGENT — owner_only blocks a non-owner's mention",
);

/* -------------------- 5. elevation lets a member through */

await req(`${base}/agents/${agent.agent.sessionAgentId}/trust`, {
  method: 'PATCH',
  body: { trustTier: 'session_trusted' },
  jar: fede,
});
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@claude-x now you may ${stamp}` },
  jar: alice,
});
const elevated = await b.waitFor('mention', 2500);
const sessionTrust = b.frames
  .filter((f) => f.type === 'mention')
  .find((f) => f.message.content.includes(`now you may ${stamp}`));
check(!!sessionTrust, 'after elevation, a member’s mention is delivered');
check(
  sessionTrust?.trust === 'session',
  'the delivered mention is labelled trust=session, not owner',
);
void elevated;

// Put it back: the default must be the safe one.
await req(`${base}/agents/${agent.agent.sessionAgentId}/trust`, {
  method: 'PATCH',
  body: { trustTier: 'owner_only' },
  jar: fede,
});

/* --------------------------- 6. an agent never hears itself */

const agent2 = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'claude-y', provider: 'codex' },
    jar: fede,
  })
).json;
const b2 = openBridge(bridgeUrl, agent2.token);
await b2.ready;
await b2.waitFor('ready');

// claude-y mentions ITSELF and claude-x in one message, posted as claude-y.
const selfRes = await fetch(
  `http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${agent2.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'post_message',
        arguments: { content: `@claude-y and @claude-x take note ${stamp}` },
      },
    }),
  },
);
check(selfRes.ok, 'an agent can post over MCP');

await new Promise((r) => setTimeout(r, 900));
check(
  !b2.frames
    .filter((f) => f.type === 'mention')
    .some((f) => f.message.content.includes(`take note ${stamp}`)),
  'an agent is NOT pushed a message it authored, even when it mentions itself',
);

/* --------------- 7. blocked mentions are visible, not silent */

const alerts = [];
const sessionStream = new WebSocket(
  `ws://localhost:9090/api/o/${S.ownerSlug}/s/${S.publicId}/stream`,
  { headers: { cookie: fede.headers.cookie } },
);
sessionStream.on('message', (d) => alerts.push(JSON.parse(String(d))));
await new Promise((r) => setTimeout(r, 500));

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@claude-x blocked probe ${stamp}` },
  jar: alice,
});
await new Promise((r) => setTimeout(r, 900));
const blocked = alerts.find((a) => a.type === 'mention.blocked');
check(!!blocked, 'a blocked mention emits mention.blocked to the browser');
check(
  blocked?.reason === 'not_trusted' && blocked?.displayName === 'claude-x',
  'the blocked event names the agent and the reason',
);
sessionStream.close();

/* ----------------- 8. no connection is reported, not swallowed */

const agent3 = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'claude-offline', provider: 'other' },
    jar: fede,
  })
).json;
void agent3;

const alerts2 = [];
const stream2 = new WebSocket(
  `ws://localhost:9090/api/o/${S.ownerSlug}/s/${S.publicId}/stream`,
  { headers: { cookie: fede.headers.cookie } },
);
stream2.on('message', (d) => alerts2.push(JSON.parse(String(d))));
await new Promise((r) => setTimeout(r, 500));

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@claude-offline are you there ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 900));
check(
  alerts2.find((a) => a.type === 'mention.blocked')?.reason === 'no_connection',
  'mentioning an agent with no live bridge reports no_connection (M5 spawns here)',
);
stream2.close();

/* --------------------------- 9. presence on disconnect */

b.ws.close();
await new Promise((r) => setTimeout(r, 700));
const afterClose = await req(base, { jar: fede });
check(
  afterClose.json.participants.find((p) => p.displayName === 'claude-x')?.status ===
    'offline',
  'closing the bridge marks the agent offline',
);

/* ---------------------------- 10. revocation kills the socket */

const tokens = await req(`${base}/tokens`, { jar: fede });
const yToken = tokens.json.find((t) => t.participantName === 'claude-y');
await req(`${base}/tokens/${yToken.id}/revoke`, { method: 'POST', jar: fede });

const reconnect = openBridge(bridgeUrl, agent2.token);
await reconnect.ready;
check(
  (await reconnect.waitFor('error'))?.code === 'not_found',
  'a revoked token cannot open a bridge',
);
reconnect.ws.close();

/* ----------------------------------------------------- cleanup */

b2.ws.close();
await req(base, { method: 'DELETE', jar: fede });
await admin(['delete-user', '--email', aliceEmail]).catch(() => {});

console.log(
  failures === 0 ? '\nM4 acceptance: PASS' : `\nM4 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
