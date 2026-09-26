/**
 * M0 acceptance check: two independent clients on one session.
 * Client A posts over HTTP; client B must receive it over the event stream.
 */
const BASE = 'http://localhost:9090/api/o/fede/s/demo';
const WS = BASE.replace('http', 'ws') + '/stream';

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

const view = await (await fetch(BASE)).json();
const fede = view.participants.find((p) => p.displayName === 'fede');
const alice = view.participants.find((p) => p.displayName === 'alice');

// Two separate sockets, standing in for two browser tabs.
const openTab = (label) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const received = [];
    ws.addEventListener('message', (e) => received.push(JSON.parse(e.data)));
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({ label, ws, received }));
  });

const tabA = await openTab('A');
const tabB = await openTab('B');

// Let the `hello` frames land.
await new Promise((r) => setTimeout(r, 300));

for (const tab of [tabA, tabB]) {
  if (tab.received[0]?.type !== 'hello') fail(`tab ${tab.label} got no hello frame`);
}
console.log('ok  both tabs received hello with participants');

const unique = `m0 check ${Date.now()}`;
const res = await fetch(`${BASE}/messages?as=${alice.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: unique }),
});
if (res.status !== 201) fail(`post returned ${res.status}`);
console.log('ok  tab A posted a message over HTTP');

await new Promise((r) => setTimeout(r, 400));

for (const tab of [tabA, tabB]) {
  const got = tab.received.find(
    (e) => e.type === 'message.created' && e.message.content === unique,
  );
  if (!got) fail(`tab ${tab.label} never received the message`);
  if (got.message.author.displayName !== 'alice') {
    fail(`tab ${tab.label} got wrong author: ${got.message.author.displayName}`);
  }
}
console.log('ok  BOTH tabs received it over the event stream, attributed to @alice');

// Persistence: a fresh HTTP read must contain it.
const history = await (await fetch(`${BASE}/messages`)).json();
if (!history.some((m) => m.content === unique)) fail('message did not persist');
console.log('ok  message persisted to history');

// A participant from another session must not be able to post here.
const bogus = await fetch(`${BASE}/messages?as=${crypto.randomUUID()}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'should not appear' }),
});
if (bogus.status !== 404) fail(`unknown participant returned ${bogus.status}, want 404`);
console.log('ok  unknown participant rejected with 404');

// Empty content is rejected.
const empty = await fetch(`${BASE}/messages?as=${fede.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: '   ' }),
});
if (empty.status !== 400) fail(`empty content returned ${empty.status}, want 400`);
console.log('ok  empty content rejected with 400');

tabA.ws.close();
tabB.ws.close();
console.log('\nM0 acceptance: PASS');
process.exit(0);
