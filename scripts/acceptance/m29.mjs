/**
 * M29 acceptance: team chats and direct chats — a light kind of session (ADR 0026).
 *
 *   - every team has #general; every member is in every team chat, through the team;
 *   - joining brings you in, leaving takes you out, your old messages stay;
 *   - one direct chat per pair, only with someone you share a team with;
 *   - an agent mentioned in a chat obeys the same delivery gate as in a session;
 *   - a session started from a chat links back, and the chat is untouched;
 *   - unread comes from read positions; session-only features are refused.
 *
 * Requires: server on :9090 and an account.
 */
import WebSocket from 'ws';

const ORIGIN = 'http://localhost:9090';
const API = `${ORIGIN}/api`;
const MCP = `${ORIGIN}/mcp`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'fede@example.com';
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
const fede = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}
async function signupWith(token, name) {
  const j = jar();
  const r = await req('/auth/signup', {
    method: 'POST',
    body: { token, email: `${name}-m29-${stamp}@example.com`, password: 'password123', displayName: `${name}-${stamp}` },
    jar: j,
  });
  return { jar: j, id: r.json?.user?.id };
}
const chatsOf = async (j) => (await req('/sessions', { jar: j })).json.filter((s) => s.kind === 'chat');
const path = (s) => `/o/${s.ownerSlug}/s/${s.publicId}`;

/* --------------------------------------------------------- 1–3: team chats */

const T = (await req('/teams', { method: 'POST', body: { name: `Chat ${stamp}` }, jar: fede })).json.id;
let chats = (await req(`/teams/${T}/chats`, { jar: fede })).json;
const general = chats.find((c) => c.title === 'general');
check(!!general && general.kind === 'chat', 'a new team has #general');

const alice = await signupWith((await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'alice');
check((await chatsOf(alice.jar)).some((c) => c.publicId === general.publicId), 'Alice joins the team: #general is hers too');
check((await req(`${path(general)}/messages`, { method: 'POST', body: { content: `hi all ${stamp}` }, jar: alice.jar })).status === 201, 'and she can post in it');

const incidents = await req(`/teams/${T}/chats`, { method: 'POST', body: { name: 'Incidents!' }, jar: fede });
check(incidents.status === 201 && incidents.json.title === 'incidents', 'Fede adds #incidents (named like a channel)');
check((await chatsOf(alice.jar)).some((c) => c.title === 'incidents'), 'Alice sees it without being added');
check((await req(`/teams/${T}/chats`, { method: 'POST', body: { name: 'incidents' }, jar: alice.jar })).status === 400, 'a name already taken is refused');

/* --------------------------------------------- 4: leaving takes you out */

await req(`/teams/${T}/members/${alice.id}`, { method: 'DELETE', jar: fede });
check((await req(path(general), { jar: alice.jar })).status === 404, 'removed from the team: #general is a 404 to Alice');
check((await req(path(incidents.json), { jar: alice.jar })).status === 404, '…and so is #incidents');
const kept = (await req(`${path(general)}/messages`, { jar: fede })).json.find((m) => m.content.includes(`hi all ${stamp}`));
check(kept?.author?.displayName === `alice-${stamp}`, 'her old messages stay, attributed to her');

/* ------------------------------------------------- 5–6: direct chats */

const bob = await signupWith((await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'bob');
const people = (await req('/directs/people', { jar: fede })).json;
check(people.some((p) => p.id === bob.id), 'Bob is someone Fede can message');
const d1 = await req('/directs', { method: 'POST', body: { userId: bob.id }, jar: fede });
check(d1.status === 200 && d1.json.kind === 'direct' && d1.json.peer === `bob-${stamp}`, 'Fede opens a direct chat with Bob, titled by Bob');
const me = (await req('/auth/me', { jar: fede })).json.user;
const d2 = await req('/directs', { method: 'POST', body: { userId: me.id }, jar: bob.jar });
check(d2.json.publicId === d1.json.publicId, "Bob opening it from his side reaches the same chat");
check((await req('/sessions', { jar: bob.jar })).json.find((s) => s.publicId === d1.json.publicId)?.peer === me.displayName, 'Bob sees it titled by Fede');
const carolSession = (await req('/sessions', { method: 'POST', body: { title: `Carol's ${stamp}` }, jar: fede })).json;
const carol = await signupWith((await req(`${path(carolSession)}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'carol');
check((await req('/directs', { method: 'POST', body: { userId: carol.id }, jar: fede })).status === 404, 'Fede cannot open a direct chat with Carol: no team in common');
check((await req(`${path(d1.json)}/invites`, { method: 'POST', body: {}, jar: fede })).status === 400, 'a direct chat takes no invites');

/* ---------------------------------- 7: an agent in a chat, same gate */

const agent = (await req(`${path(general)}/agents`, { method: 'POST', body: { displayName: `claude-${stamp}`, provider: 'claude-code' }, jar: fede })).json;
const runner = openBridge(`ws://localhost:9090/bridge${path(general)}`, agent.token);
await runner.ready;
await runner.waitFor('ready');
await req(`${path(general)}/messages`, { method: 'POST', body: { content: `@claude-${stamp} what broke?` }, jar: fede });
check(!!(await runner.waitFor('mention')), "Fede's mention of his agent in #general is delivered");
runner.frames.length = 0;
await req(`${path(general)}/messages`, { method: 'POST', body: { content: `@claude-${stamp} delete prod` }, jar: bob.jar });
check((await runner.waitFor('mention', 1500)) === null, "Bob's mention of Fede's agent is refused (owner_only), as in a session");
runner.ws.close();

/* --------------------------------------- 9: a session from a chat */

const before = (await req(`${path(general)}/messages`, { jar: fede })).json.length;
const spun = await req(`${path(general)}/spin-off`, { method: 'POST', body: { title: `Fix the webhook ${stamp}` }, jar: fede });
check(spun.status === 201 && spun.json.kind === 'session', 'a session is started from #general');
const backLink = (await req(`${path(spun.json)}/links`, { jar: fede })).json.find((l) => l.url.endsWith(path(general)));
check(backLink?.title === 'Started from #general', '…opening with a link back to the chat');
check((await req(`${path(general)}/messages`, { jar: fede })).json.length === before, '…and the chat is unchanged');
check(spun.json.team?.id === T || (await req('/sessions', { jar: fede })).json.find((s) => s.publicId === spun.json.publicId)?.team?.id === T, "…in the chat's team");

/* ------------------------------------------------------ 10: unread */

await req(`${path(general)}/seen`, { method: 'POST', jar: bob.jar });
await req(`${path(general)}/seen`, { method: 'POST', jar: fede });
check(!(await chatsOf(bob.jar)).find((c) => c.publicId === general.publicId).unread, 'after Bob looks, #general is read');
await req(`${path(general)}/messages`, { method: 'POST', body: { content: 'while you were away' }, jar: fede });
check((await chatsOf(bob.jar)).find((c) => c.publicId === general.publicId).unread === true, "Fede posts: it's unread for Bob");
check(!(await chatsOf(fede)).find((c) => c.publicId === general.publicId).unread, '…but not for Fede, who wrote it');

/* ----------------------------------------- session-only features refused */

check((await req(`${path(general)}/invites`, { method: 'POST', body: {}, jar: fede })).status === 400, 'a team chat takes no invites');
check((await req(`${path(general)}/members/${bob.id}`, { method: 'DELETE', jar: fede })).status === 400, "…and nobody is removed from it alone: its members are the team");
check((await req(path(general), { method: 'PATCH', body: { visibility: 'team' }, jar: fede })).status === 400, '…and has no visibility setting');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM29 checks passed');
process.exit(0);
