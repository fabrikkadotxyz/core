/**
 * M23 acceptance: comments on outputs — review as a conversation about a passage.
 *
 * Story S9: students write a paper; their advisor, a guest, comments on two
 * passages; an agent fixes one and resolves it by editing; a student rewrites the
 * other and it shows as outdated, never moved.
 * Story S12: an agency's client, a guest on one session, comments on the
 * proposal; the agency's internal session does not exist for them.
 * Plus: anchors follow the anchored-edit rule; a failed edit resolves nothing;
 * a viewer resolves only their own thread; a comment never wakes an agent.
 *
 * Requires: server on :9090 and an account.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
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

/** A browser, minus the browser: a Yjs document synced over the real socket. */
function yclient(path, cookie) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const ws = new WebSocket(`ws://localhost:9090/api${path}`, { headers: { cookie } });
  ws.binaryType = 'arraybuffer';
  const state = { synced: false, error: null, closed: false };

  const send = (fn) => {
    const e = encoding.createEncoder();
    fn(e);
    if (ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(e));
  };

  doc.on('update', (update, origin) => {
    if (origin === ws) return;
    send((e) => {
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, update);
    });
  });

  ws.on('open', () =>
    send((e) => {
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, doc);
    }),
  );
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'stream.error') state.error = msg.code;
      return;
    }
    const d = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(d);
    if (type === 0) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      const kind = syncProtocol.readSyncMessage(d, e, doc, ws);
      if (kind === 1) state.synced = true;
      if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
    } else if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), ws);
    }
  });
  ws.on('close', () => (state.closed = true));

  return {
    doc,
    state,
    text: (file) => doc.getMap('files').get(file),
    async ready() {
      for (let i = 0; i < 50 && !state.synced && !state.error && !state.closed; i++) await sleep(50);
      return state.synced;
    },
    close: () => ws.close(),
  };
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
    body: { token, email: `${name}-m23-${stamp}@example.com`, password: 'password123', displayName: `${name}-${stamp}` },
    jar: j,
  });
  return { jar: j, id: r.json?.user?.id, status: r.status };
}

/* ------------------------------------------------------- S9: the paper */

const S = (await req('/sessions', { method: 'POST', body: { title: `Thesis ${stamp}` }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const alice = await signupWith((await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'alice');
const advisor = await signupWith((await req(`${base}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede })).json.token, 'advisor');
check(advisor.status === 201 && (await req(base, { jar: advisor.jar })).json?.me?.role === 'viewer', 'the advisor joins as a guest');

const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `claude-${stamp}`, provider: 'claude-code' }, jar: fede })).json;
const kinds = (await req(`${base}/output-kinds`, { jar: fede })).json;
const kind = kinds.find((k) => k.kind === 'latex' && k.available) ? 'latex' : 'doc';
const P = (await tool(mcpUrl, agent.token, 'create_output', { kind, name: 'Retry storms' })).value;
const file = kind === 'latex' ? 'main.tex' : 'document.md';
await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: P.id,
  file,
  append: '\nRetries are always safe to repeat.\nWe measured a 40% drop in duplicate charges.\n',
});

const cpath = `${base}/outputs/${P.id}/comments`;
const c1 = await req(cpath, { method: 'POST', body: { file, quote: 'Retries are always safe to repeat.', body: 'Not without idempotency keys — cite it.' }, jar: advisor.jar });
check(c1.status === 200 && c1.json.id, 'S9: the advisor (a guest) comments on a passage');
const c2 = await req(cpath, { method: 'POST', body: { file, quote: 'a 40% drop in duplicate charges', body: 'Over what period?' }, jar: advisor.jar });
check(c2.status === 200, 'S9: …and on a second one');
check((await req(cpath, { method: 'POST', body: { file, quote: 'not in the paper at all', body: 'x' }, jar: advisor.jar })).json?.code === 'anchor_not_found', 'a comment must quote text that is there');
check((await req(cpath, { method: 'POST', body: { file, quote: 'e', body: 'x' }, jar: advisor.jar })).json?.code === 'anchor_ambiguous', '…exactly once');
check((await req(`${base}/outputs/${P.id}/comments/${c1.json.id}/replies`, { method: 'POST', body: { body: 'Adding the citation.' }, jar: alice.jar })).status === 200, 'a student replies in the thread');

let threads = (await tool(mcpUrl, agent.token, 'list_comments', { output_id: P.id })).value;
check(threads?.length === 2 && threads[0].quote === 'Retries are always safe to repeat.' && threads[0].replies.length === 1, 'the agent reads both threads, with quotes and replies');

// A failed edit resolves nothing.
const failedEdit = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: P.id, file, edits: [{ old_text: 'no such sentence', new_text: 'x' }], resolves: c1.json.id,
});
check(/anchor_not_found/.test(failedEdit.error ?? ''), 'an edit that fails…');
check((await tool(mcpUrl, agent.token, 'list_comments', { output_id: P.id })).value[0].status === 'open', '…resolves nothing');

const fix = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: P.id,
  file,
  edits: [{ old_text: 'Retries are always safe to repeat.', new_text: 'Retries are safe to repeat when every charge carries an idempotency key.' }],
  resolves: c1.json.id,
});
check(fix.value?.resolved === c1.json.id, 'S9: the agent fixes the passage and resolves the comment in one edit');
threads = (await req(cpath, { jar: advisor.jar })).json;
const t1 = threads.find((t) => t.id === c1.json.id);
check(t1.status === 'resolved' && t1.resolvedBy === `claude-${stamp}` && t1.resolvedAtVersion === fix.value.version, '…resolved by the agent, at the version that fixed it');
check(t1.outdated === true, '…and its quote is gone, as it should be once fixed');
check((await tool(mcpUrl, agent.token, 'edit_output', { output_id: P.id, file, append: 'x', resolves: c1.json.id })).error?.includes('already resolved'), 'resolving twice is refused');

// A student rewrites the second passage by typing in the browser.
const studentDoc = yclient(`${base}/outputs/${P.id}/sync`, alice.jar.cookie);
await studentDoc.ready();
const yt = studentDoc.text(file);
const at = yt.toString().indexOf('40% drop');
studentDoc.doc.transact(() => { yt.delete(at, '40% drop'.length); yt.insert(at, 'large drop'); });
await sleep(500);
threads = (await req(cpath, { jar: advisor.jar })).json;
const t2 = threads.find((t) => t.id === c2.json.id);
check(t2.status === 'open' && t2.outdated === true, 'S9: the student rewrote that paragraph — the comment is outdated, still open, not moved');
check(t2.quote === 'a 40% drop in duplicate charges', '…and still shows what it was about');
studentDoc.close();

const edits = (await req(`${base}/outputs/${P.id}/changes`, { jar: fede })).json;
check(edits.some((e) => e.displayName === `claude-${stamp}`) && edits.some((e) => e.displayName === `alice-${stamp}`), 'the changes log says who wrote what');

/* ------------------------------------------------ who may resolve, and silence */

const mine = await req(cpath, { method: 'POST', body: { file, quote: 'idempotency key', body: 'Define this term.' }, jar: advisor.jar });
check((await req(`${base}/outputs/${P.id}/comments/${c2.json.id}/resolve`, { method: 'POST', jar: advisor.jar })).status === 200, 'a guest resolves a thread they started');
const aliceThread = await req(cpath, { method: 'POST', body: { file, quote: 'large drop', body: 'Source?' }, jar: alice.jar });
check((await req(`${base}/outputs/${P.id}/comments/${aliceThread.json.id}/resolve`, { method: 'POST', jar: advisor.jar })).status === 404, '…but not someone else\'s');
check((await req(`${base}/outputs/${P.id}/comments/${mine.json.id}/resolve`, { method: 'POST', jar: fede })).status === 200, 'a member resolves any thread');
check((await req(`${base}/outputs/${P.id}/comments/${mine.json.id}/reopen`, { method: 'POST', jar: fede })).status === 200, '…and can reopen it');

const runner = openBridge(`ws://localhost:9090/bridge/o/${S.ownerSlug}/s/${S.publicId}`, agent.token);
await runner.ready;
await runner.waitFor('ready');
await req(cpath, { method: 'POST', body: { file, quote: 'large drop', body: `@claude-${stamp} please fix this now` }, jar: alice.jar });
check((await runner.waitFor('mention', 1500)) === null, 'a comment that names an agent wakes nothing');
runner.ws.close();

/* --------------------------------------------- S12: the agency and its client */

const internal = (await req('/sessions', { method: 'POST', body: { title: `Acme internal ${stamp}` }, jar: fede })).json;
const C = (await req('/sessions', { method: 'POST', body: { title: `Acme proposal ${stamp}` }, jar: fede })).json;
const cbase = `/o/${C.ownerSlug}/s/${C.publicId}`;
const client = await signupWith((await req(`${cbase}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede })).json.token, 'client');
const cagent = (await req(`${cbase}/agents`, { method: 'POST', body: { displayName: `drafter-${stamp}`, provider: 'claude-code' }, jar: fede })).json;
const prop = (await tool(`${MCP}/o/${C.ownerSlug}/s/${C.publicId}`, cagent.token, 'create_output', { kind: 'doc', name: 'Proposal', content: 'Phase 1 takes six weeks.' })).value;
await req(`${cbase}/context`, { method: 'PATCH', body: { add: { decisions: ['Fixed price for phase 1'] } }, jar: fede });

check((await req(`${cbase}/outputs`, { jar: client.jar })).json?.some((o) => o.name === 'Proposal'), 'S12: the client sees the proposal');
check((await req(`${cbase}/context`, { jar: client.jar })).json?.decisions?.includes('Fixed price for phase 1'), 'S12: …and the decisions');
check((await req(`${cbase}/outputs/${prop.id}/comments`, { method: 'POST', body: { quote: 'six weeks', body: 'Can this be four?' }, jar: client.jar })).status === 200, 'S12: the client comments on the proposal');
check((await req(`${cbase}/outputs`, { method: 'POST', body: { kind: 'doc', name: 'x' }, jar: client.jar })).status === 404, 'S12: but cannot edit or create');
check((await req(`/o/${internal.ownerSlug}/s/${internal.publicId}`, { jar: client.jar })).status === 404, "S12: the agency's internal session does not exist for the client");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM23 checks passed');
process.exit(0);
