/**
 * M19 acceptance: session links — pointers to outside things, never copies.
 *
 * Checked without any vendor account:
 *   - an agent links a ticket, a PR, a wiki page and an error; the browser sees them;
 *   - linking the same URL again is an update (how a status change is reported),
 *     and fields left out keep their value;
 *   - only http(s) URLs, only known types; removal is explicit;
 *   - a non-member gets 404, not the list;
 *   - a spawned run's mention frame carries the linked repos for its preamble.
 *
 * The story half — a real tracker's ticket moved by a real agent — needs M18's
 * connections and is part of the manual test.
 *
 * Requires: server on :9090 and an account.
 */
import WebSocket from 'ws';

const ORIGIN = 'http://localhost:9090';
const API = `${ORIGIN}/api`;
const MCP = `${ORIGIN}/mcp`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
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

async function tool(url, token, name, args = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.text();
  const payload = body.includes('data: ')
    ? JSON.parse(body.split('data: ').pop())
    : JSON.parse(body);
  const result = payload.result;
  if (payload.error || result?.isError) {
    return { error: payload.error?.message ?? result?.content?.[0]?.text ?? 'error' };
  }
  const t = result?.content?.[0]?.text;
  try {
    return { value: t ? JSON.parse(t) : t };
  } catch {
    return { value: t };
  }
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
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}
const S = (await req('/sessions', { method: 'POST', body: { title: `Links ${stamp}` }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (
  await req(`${base}/agents`, { method: 'POST', body: { displayName: `linker-${stamp}`, provider: 'claude-code' }, jar: fede })
).json;

/* ------------------------------------------------ 1. an agent links things */

const TICKET = 'https://acme.atlassian.net/browse/PAY-142';
const PR = 'https://github.com/acme/payments/pull/88';
const links = [
  { url: TICKET, type: 'issue', title: 'PAY-142 Webhook retries double-charge', status: 'To Do', provider: 'jira' },
  { url: PR, type: 'pr', title: 'Idempotency key on webhook retries' },
  { url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/9/Payments', type: 'page', title: 'Payments runbook' },
  { url: 'https://acme.sentry.io/issues/4411/', type: 'error', title: 'DuplicateCharge' },
];
for (const l of links) {
  const r = await tool(mcpUrl, agent.token, 'link', l);
  check(!r.error && r.value?.url === l.url, `the agent links a ${l.type}`);
}

let listed = (await req(`${base}/links`, { jar: fede })).json;
check(listed?.length === 4, 'the browser sees all four links');
const pr = listed.find((l) => l.url === PR);
check(pr?.provider === 'github.com', 'a provider left out is the hostname');
check(pr?.addedBy === `linker-${stamp}`, 'a link says who added it');
check(listed.find((l) => l.url === TICKET)?.provider === 'jira', 'a provider given is kept as written');

/* ----------------------------------- 2. linking again is the status report */

const before = listed.find((l) => l.url === TICKET);
await sleep(20);
await tool(mcpUrl, agent.token, 'link', { url: TICKET, type: 'issue', status: 'In Review' });
listed = (await req(`${base}/links`, { jar: fede })).json;
const after = listed.find((l) => l.url === TICKET);
check(listed.length === 4, 'linking the same URL again does not duplicate it');
check(after?.status === 'In Review', 'the new status is recorded');
check(after?.title === before.title, 'a field left out keeps its value');
check(after?.statusAt && after.statusAt > before.statusAt, 'the status carries when it was reported');

const filtered = await tool(mcpUrl, agent.token, 'list_links', { type: 'issue' });
check(filtered.value?.length === 1 && filtered.value[0].url === TICKET, 'list_links filters by type');

/* ----------------------------------------------------- 3. what is refused */

const js = await tool(mcpUrl, agent.token, 'link', { url: 'javascript:alert(1)', type: 'page' });
check(js.error?.includes('invalid_link'), 'a javascript: URL is refused');
const rel = await req(`${base}/links`, { method: 'PUT', body: { url: '/relative', type: 'page' }, jar: fede });
check(rel.status === 400, 'a relative URL is refused');
const badType = await req(`${base}/links`, { method: 'PUT', body: { url: 'https://x.test/1', type: 'meme' }, jar: fede });
check(badType.status === 400, 'an unknown type is refused');

/* ----------------------------------------------------- 4. privacy, removal */

const carol = jar();
const other = (await req('/sessions', { method: 'POST', body: { title: `Elsewhere ${stamp}` }, jar: fede })).json;
const otherInv = await req(`/o/${other.ownerSlug}/s/${other.publicId}/invites`, { method: 'POST', body: {}, jar: fede });
await req('/auth/signup', {
  method: 'POST',
  body: { token: otherInv.json.token, email: `carol-m19-${stamp}@example.com`, password: 'password123', displayName: `carol-m19-${stamp}` },
  jar: carol,
});
const peek = await req(`${base}/links`, { jar: carol });
check(peek.status === 404, "a non-member gets 404 for a session's links, not the list");

const removed = await req(`${base}/links?url=${encodeURIComponent(PR)}`, { method: 'DELETE', jar: fede });
check(removed.status === 200, 'a member unlinks a PR');
listed = (await req(`${base}/links`, { jar: fede })).json;
check(listed.length === 3 && !listed.some((l) => l.url === PR), '…and it is gone, the others untouched');
const again = await tool(mcpUrl, agent.token, 'unlink', { url: PR });
check(again.error?.includes('invalid_link'), 'unlinking something not linked says so');

/* ------------------------------------------- 5. repos reach a run's preamble */

const runner = openBridge(`ws://localhost:9090/bridge/o/${S.ownerSlug}/s/${S.publicId}`, agent.token);
await runner.ready;
await runner.waitFor('ready');
await req(`${base}/messages`, { method: 'POST', body: { content: `@linker-${stamp} no repos yet ${stamp}` }, jar: fede });
const bare = await runner.waitFor('mention');
check(!!bare && bare.repos === undefined, 'with no repos linked, the mention frame has no repos field');

await tool(mcpUrl, agent.token, 'link', { url: 'https://github.com/acme/payments', type: 'repo', title: 'payments' });
await tool(mcpUrl, agent.token, 'link', { url: 'https://github.com/acme/ledger', type: 'repo', title: 'ledger' });
runner.frames.length = 0;
await req(`${base}/messages`, { method: 'POST', body: { content: `@linker-${stamp} now with repos ${stamp}` }, jar: fede });
const withRepos = await runner.waitFor('mention');
check(
  withRepos?.repos?.length === 2 &&
    withRepos.repos[0].url === 'https://github.com/acme/payments' &&
    withRepos.repos[1].title === 'ledger',
  'a mention carries both linked repos, in the order they were linked',
);
runner.ws.close();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM19 checks passed');
