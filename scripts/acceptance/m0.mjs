/**
 * M0 acceptance: two clients on one session, realtime fan-out, persistence.
 *
 * Updated for M1: the API is authenticated and a message's author comes from
 * the session cookie, not a query parameter. The M0 *property* being checked is
 * unchanged — one client posts, every client sees it, history survives.
 *
 * Requires: server on :9090 and the demo session (pnpm db:seed).
 * Run: node scripts/acceptance/m0.mjs
 */
const API = 'http://localhost:9090/api';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

/* ------------------------------------------------------------------ login */

let cookie = '';
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) {
  fail(
    `could not log in as ${EMAIL}. Create an account first:\n` +
      `  node scripts/acceptance/_setup.mjs   (creates the test account)`,
  );
}
for (const c of loginRes.headers.getSetCookie?.() ?? []) {
  const [pair] = c.split(';');
  if (pair?.startsWith('fabrikka_session=')) cookie = pair;
}
if (!cookie) fail('login succeeded but set no session cookie');
console.log('ok  logged in');

/* ------------------------------------------------ find the demo session */

const list = await (await fetch(`${API}/sessions`, { headers: { cookie } })).json();
// The seeded demo session if there is one; otherwise make one, so a fresh test
// account (scripts/acceptance/_setup.mjs) needs no seeding first.
const demo =
  list.find((s) => s.publicId === 'demo') ??
  list.find((s) => (s.kind ?? 'session') === 'session') ??
  (await (
    await fetch(`${API}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'M0 check' }),
    })
  ).json());
if (!demo?.publicId) fail('could not find or create a session');

const BASE = `${API}/o/${demo.ownerSlug}/s/${demo.publicId}`;
const WS = BASE.replace('http', 'ws') + '/stream';
console.log(`ok  using session /o/${demo.ownerSlug}/s/${demo.publicId}`);

/* --------------------------------------------- two clients, one session */

const openTab = (label) =>
  new Promise((resolve, reject) => {
    // The stream authenticates with the same cookie as the REST API.
    const ws = new WebSocket(WS, { headers: { cookie } });
    const received = [];
    ws.addEventListener('message', (e) => received.push(JSON.parse(e.data)));
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({ label, ws, received }));
  });

const tabA = await openTab('A');
const tabB = await openTab('B');

await new Promise((r) => setTimeout(r, 300));

for (const tab of [tabA, tabB]) {
  if (tab.received[0]?.type !== 'hello') fail(`tab ${tab.label} got no hello frame`);
}
console.log('ok  both tabs received hello with participants');

const unique = `m0 check ${Date.now()}`;
const posted = await fetch(`${BASE}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ content: unique }),
});
if (posted.status !== 201) fail(`post returned ${posted.status}`);
console.log('ok  tab A posted a message over HTTP');

await new Promise((r) => setTimeout(r, 400));

for (const tab of [tabA, tabB]) {
  const got = tab.received.find(
    (e) => e.type === 'message.created' && e.message.content === unique,
  );
  if (!got) fail(`tab ${tab.label} never received the message`);
  if (got.message.author.displayName !== demo.ownerSlug) {
    fail(`tab ${tab.label} got unexpected author: ${got.message.author.displayName}`);
  }
}
console.log('ok  BOTH tabs received it over the event stream, correctly attributed');

const history = await (await fetch(`${BASE}/messages`, { headers: { cookie } })).json();
if (!history.some((m) => m.content === unique)) fail('message did not persist');
console.log('ok  message persisted to history');

const empty = await fetch(`${BASE}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ content: '   ' }),
});
if (empty.status !== 400) fail(`empty content returned ${empty.status}, want 400`);
console.log('ok  empty content rejected with 400');

/**
 * The stream is not a way around auth.
 *
 * Wait for `close` specifically: an abnormal closure also fires `error`, and
 * whichever listener resolves first would otherwise hide the close code.
 */
const anonResult = await new Promise((resolve) => {
  const ws = new WebSocket(WS);
  const received = [];
  const timer = setTimeout(() => resolve(received), 3000);
  ws.addEventListener('message', (e) => received.push(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    clearTimeout(timer);
    resolve(received);
  });
  ws.addEventListener('error', () => {});
});
const refusal = anonResult.find((e) => e.type === 'stream.error');
if (!refusal) fail('unauthenticated stream did not send a stream.error frame');
if (refusal.code !== 'unauthenticated') {
  fail(`stream refused with code "${refusal.code}", want "unauthenticated"`);
}
if (anonResult.some((e) => e.type === 'hello')) {
  fail('unauthenticated stream leaked a hello frame');
}
console.log('ok  unauthenticated stream refused in-band, leaks no session data');

/** A non-existent session must be refused the same way a private one is. */
const ghost = await new Promise((resolve) => {
  const ws = new WebSocket(`${API.replace('http', 'ws')}/o/${demo.ownerSlug}/s/does-not-exist/stream`, {
    headers: { cookie },
  });
  const received = [];
  const timer = setTimeout(() => resolve(received), 3000);
  ws.addEventListener('message', (e) => received.push(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    clearTimeout(timer);
    resolve(received);
  });
  ws.addEventListener('error', () => {});
});
if (ghost.find((e) => e.type === 'stream.error')?.code !== 'not_found') {
  fail('stream for a non-existent session was not refused with not_found');
}
console.log('ok  stream for an unknown session refused with not_found');

tabA.ws.close();
tabB.ws.close();
console.log('\nM0 acceptance: PASS');
process.exit(0);
