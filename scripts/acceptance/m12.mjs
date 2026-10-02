/**
 * M12 acceptance: outputs — live documents the session edits together.
 *
 * The properties that matter (ADR 0019):
 *   - two humans typing at once both survive, and see each other live;
 *   - an agent's anchored edit lands while a human types elsewhere;
 *   - a stale anchor is refused and changes nothing — all edits or none;
 *   - every change is attributed to whoever made it;
 *   - an edit wakes nobody and costs no turn budget.
 *
 * Browsers are simulated with stock Yjs clients over the real sync socket, so
 * this exercises the same protocol the web app speaks.
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
  await req('/sessions', { method: 'POST', body: { title: `Outputs ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;

const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: {
    token: inv.json.token,
    email: `alice-m12-${stamp}@example.com`,
    password: 'password123',
    displayName: `alice-m12-${stamp}`,
  },
  jar: alice,
});

const agent = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: `writer-${stamp}`, provider: 'claude-code' },
    jar: fede,
  })
).json;

/* ------------------------------------------------ 1. the catalogue, create */

const kinds = (await req(`${base}/output-kinds`, { jar: fede })).json;
check(kinds?.some((k) => k.kind === 'doc' && k.available), 'the catalogue offers a document');

const created = await req(`${base}/outputs`, {
  method: 'POST',
  body: { kind: 'doc', name: 'Report' },
  jar: fede,
});
check(created.status === 201, 'a member creates a document called Report');
const R = created.json;
check(R.mainFile === 'document.md' && R.files.includes('document.md'), 'it has one file');

const listed = (await req(`${base}/outputs`, { jar: alice })).json;
check(listed?.[0]?.id === R.id, 'every member sees it in the list');

/* --------------------------------------- 2. two humans typing at once */

const syncPath = `${base}/outputs/${R.id}/sync`;
const A = yclient(syncPath, fede.cookie);
const B = yclient(syncPath, alice.cookie);
check((await A.ready()) && (await B.ready()), 'both browsers sync');

A.text('document.md').insert(A.text('document.md').length, 'Fede paragraph.\n\nAlice: ');
await sleep(300);
// Interleaved keystrokes, in two places.
for (const [i, ch] of [...'starts here'].entries()) {
  const fa = A.text('document.md');
  fa.insert(fa.toString().indexOf('Fede paragraph') + 4 + i, i === 0 ? ' X' : '');
  const fb = B.text('document.md');
  fb.insert(fb.length, ch);
  await sleep(15);
}
await sleep(500);
const textA = A.text('document.md').toString();
const textB = B.text('document.md').toString();
check(textA === textB, 'both see the same text, live');
check(textA.includes('Alice: starts here'), "Alice's typing is there");
check(textA.includes('Fede X'), "Fede's concurrent typing is there too");

/* -------- 3. an agent edits by anchor while a human types elsewhere */

const listedByAgent = await tool(mcpUrl, agent.token, 'list_outputs');
check(listedByAgent.value?.some((o) => o.id === R.id), 'the agent lists outputs');

const read = await tool(mcpUrl, agent.token, 'read_output', { output_id: R.id });
check(read.value?.content?.includes('Fede X paragraph.'), 'the agent reads the document');
check(read.value?.format === 'markdown', 'it is told the format');

// A human types in Alice's paragraph between the agent's read and its write.
B.text('document.md').insert(B.text('document.md').length, ' — and continues');
await sleep(200);

const edit = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: R.id,
  edits: [{ old_text: 'Fede X paragraph.', new_text: 'Fede X paragraph, tightened by the agent.' }],
});
check(!edit.error, `the agent's anchored edit lands${edit.error ? `: ${edit.error}` : ''}`);
await sleep(300);
const merged = A.text('document.md').toString();
check(merged.includes('tightened by the agent'), "the agent's edit arrives in the browser live");
check(merged.includes('— and continues'), "THE HUMAN'S CONCURRENT TYPING SURVIVED");

/* ------------------------------------ 4. stale anchors are refused, atomically */

const stale = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: R.id,
  edits: [{ old_text: 'Fede X paragraph.', new_text: 'again' }],
});
check(stale.error?.startsWith('anchor_not_found'), 'a rewritten anchor gets anchor_not_found');

const before = A.text('document.md').toString();
const half = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: R.id,
  edits: [
    { old_text: 'tightened by the agent', new_text: 'CHANGED' },
    { old_text: 'not in the document', new_text: 'x' },
  ],
});
await sleep(200);
check(!!half.error, 'a call whose second anchor is missing fails');
check(A.text('document.md').toString() === before, 'and NEITHER edit applied');

/* --------------------------------- 5. wholesale replace is guarded */

const blind = await tool(mcpUrl, agent.token, 'edit_output', { output_id: R.id, content: 'gone' });
check(!!blind.error, 'replacing without if_version is refused');
const old = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: R.id,
  content: 'gone',
  if_version: 1,
});
check(old.error?.startsWith('version_moved'), 'replacing with a stale version is refused');

const appended = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: R.id,
  append: '## Next steps\n',
});
check(!appended.error, 'the agent can append');

/* --------------- 6. edits are display data: no messages, no budget */

const budgetBefore = (await req(`${base}/pause`, { jar: fede })).json;
await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: R.id,
  append: 'One more line.\n',
});
const budgetAfter = (await req(`${base}/pause`, { jar: fede })).json;
check(budgetAfter.turnsUsed === budgetBefore.turnsUsed, 'an edit costs no turn budget');
const msgs = (await req(`${base}/messages`, { jar: fede })).json;
check(msgs.length === 0, 'an edit posts no message, so it can wake nobody');

const timeline = (await req(`${base}/output-edits`, { jar: fede })).json;
check(
  timeline.some((e) => e.displayName === `writer-${stamp}` && e.outputName === 'Report'),
  'the timeline can show "writer edited Report"',
);

/* ------------------------------------------ 7. the changes log */

// Closing the last browser records what the humans typed, without waiting.
A.close();
B.close();
await sleep(800);
const changes = (await req(`${base}/outputs/${R.id}/changes`, { jar: alice })).json;
const by = (name) => changes.filter((e) => e.displayName === name);
check(by(`writer-${stamp}`).length >= 1, "the agent's edits are in the changes log");
check(
  by(`writer-${stamp}`).some((e) => e.diff.includes('+Fede X paragraph, tightened by the agent.')),
  "…with the diff of what it changed",
);
const fedeRows = changes.filter((e) => e.participantKind === 'human' && e.diff.includes('Fede X'));
const aliceRows = by(`alice-m12-${stamp}`);
check(fedeRows.length >= 1, "Fede's typing is attributed to Fede");
check(aliceRows.length >= 1, "Alice's typing is attributed to Alice");
check(
  aliceRows.every((e) => !e.diff.split('\n').some((l) => /^[+-].*Fede X/.test(l))),
  "Alice's rows do not claim Fede's changes",
);

// Reload: a fresh browser sees everything.
const C = yclient(syncPath, fede.cookie);
await C.ready();
const reloaded = C.text('document.md').toString();
check(reloaded.includes('— and continues') && reloaded.includes('One more line.'), 'a reload loses nothing');
C.close();

/* ----------------------------------------- 8. access */

const outsider = jar();
const N = yclient(syncPath, outsider.cookie);
await N.ready();
check(N.state.error === 'unauthenticated' && !N.state.synced, 'no cookie, no socket');

const wrong = yclient(`${base}/outputs/00000000-0000-0000-0000-000000000000/sync`, fede.cookie);
await wrong.ready();
check(wrong.state.error === 'not_found', 'an unknown output is not_found');
N.close();
wrong.close();

const del = await req(`${base}/outputs/${R.id}`, { method: 'DELETE', jar: alice });
check(del.status === 404, "a member cannot delete someone else's document");
const rename = await req(`${base}/outputs/${R.id}`, {
  method: 'PATCH',
  body: { name: 'Final report' },
  jar: alice,
});
check(rename.status === 200, 'any member can rename it');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM12 acceptance: all checks passed');
// Sockets the server refused can linger in CLOSING; do not wait on them.
process.exit(0);
