/**
 * M22 acceptance: who can see a session — team-visible, and guests (ADR 0025).
 *
 * Story S2: a team-visible session every teammate can read along with, live,
 * without being able to post or mention. Plus Threat 8 in docs/security.md:
 *   - viewers reach only the read allowlist; every other route is a 404;
 *   - a viewer's view has no member list and no MCP endpoint;
 *   - a viewer syncing an output CANNOT change it — enforced by the server;
 *   - guests see one session and nothing else of the team;
 *   - team viewing ends with team membership or `private`, with no cleanup;
 *   - "team" needs a team, and leaving the team resets visibility.
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
const fede = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}
async function signupWith(token, name) {
  const j = jar();
  const r = await req('/auth/signup', {
    method: 'POST',
    body: { token, email: `${name}-m22-${stamp}@example.com`, password: 'password123', displayName: `${name}-${stamp}` },
    jar: j,
  });
  return { jar: j, id: r.json?.user?.id, status: r.status };
}

/* ------------------------------------------------------------------ setup */

const T = (await req('/teams', { method: 'POST', body: { name: `Vis ${stamp}` }, jar: fede })).json.id;
const alice = await signupWith((await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'alice');
const lone = (await req('/sessions', { method: 'POST', body: { title: `Elsewhere ${stamp}` }, jar: fede })).json;
const carol = await signupWith((await req(`/o/${lone.ownerSlug}/s/${lone.publicId}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'carol');

const noTeam = (await req('/sessions', { method: 'POST', body: { title: `No team ${stamp}` }, jar: fede })).json;
const refused = await req(`/o/${noTeam.ownerSlug}/s/${noTeam.publicId}`, { method: 'PATCH', body: { visibility: 'team' }, jar: fede });
check(refused.status === 400, '"team" visibility needs a team');

const S = (await req('/sessions', { method: 'POST', body: { title: `Team-visible ${stamp}`, teamId: T }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
check((await req(base, { jar: alice.jar })).status === 404, 'before: a team session is private — Alice gets 404');

const made = await req(base, { method: 'PATCH', body: { visibility: 'team' }, jar: fede });
check(made.status === 200, 'Fede makes it team-visible');
check((await req(base, { jar: fede })).json.visibility === 'team', 'the session says it is team-visible');

/* ------------------------------------------------------------- S2: reading */

const listed = (await req('/sessions', { jar: alice.jar })).json.find((x) => x.publicId === S.publicId);
check(listed?.role === 'viewer', 'S2: it appears in Alice\'s list, as a viewer');
const view = await req(base, { jar: alice.jar });
check(view.status === 200 && view.json.me.role === 'viewer' && view.json.me.participantId === null, 'S2: Alice opens it — as a viewer with no participant');
check(view.json.members.length === 0 && view.json.mcpEndpoint === '', 'a viewer\'s view has no member list (emails) and no MCP endpoint');
check(!view.json.participants.some((p) => p.displayName === `alice-${stamp}`), 'a viewer is not a participant');

await req(`${base}/messages`, { method: 'POST', body: { content: `findings so far ${stamp}` }, jar: fede });
const msgs = await req(`${base}/messages`, { jar: alice.jar });
check(msgs.status === 200 && msgs.json.some((m) => m.content.includes(`findings so far ${stamp}`)), 'S2: Alice reads the timeline');
for (const path of ['/context', '/links', '/artifacts', '/outputs', '/participants', '/output-edits']) {
  check((await req(`${base}${path}`, { jar: alice.jar })).status === 200, `a viewer reads ${path}`);
}

/* ----------------------------------------- S2: and nothing else (fail closed) */

check((await req(`${base}/messages`, { method: 'POST', body: { content: `@writer-${stamp} do it` }, jar: alice.jar })).status === 404, 'S2: Alice cannot post — so cannot mention, so cannot start an agent');
const writes = [
  ['PATCH', '/context', { add: { facts: ['x'] } }],
  ['PUT', '/links', { url: 'https://x.test/1', type: 'issue' }],
  ['POST', '/outputs', { kind: 'doc', name: 'x' }],
  ['POST', '/agents', { displayName: 'sneaky', provider: 'claude-code' }],
  ['POST', '/tokens', {}],
  ['POST', '/pause', {}],
];
for (const [method, path, body] of writes) {
  check((await req(`${base}${path}`, { method, body, jar: alice.jar })).status === 404, `a viewer's ${method} ${path} is a 404`);
}
for (const path of ['/members', '/agents', '/tokens', '/integrations', '/invites', '/roster', '/team']) {
  check((await req(`${base}${path}`, { jar: alice.jar })).status === 404, `a viewer cannot read Setup's ${path}`);
}
check((await req(base, { jar: carol.jar })).status === 404, 'Carol, outside the team, gets 404');

/* ------------------------------- read-only sync: the server, not the editor */

const writer = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `writer-${stamp}`, provider: 'claude-code' }, jar: fede })).json;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const created = await tool(mcpUrl, writer.token, 'create_output', { kind: 'doc', name: 'Report', content: 'Original text.' });
const O = created.value.id;

const viewerDoc = yclient(`${base}/outputs/${O}/sync`, alice.jar.cookie);
check(await viewerDoc.ready(), 'a viewer syncs the output');
check(viewerDoc.text('document.md')?.toString() === 'Original text.', '…and sees its content');
viewerDoc.doc.transact(() => viewerDoc.text('document.md').insert(0, 'VANDALISED '));
await sleep(400);
const after = await tool(mcpUrl, writer.token, 'read_output', { output_id: O });
check(after.value?.content === 'Original text.', "THE VIEWER'S EDIT NEVER REACHED THE DOCUMENT");
const memberDoc = yclient(`${base}/outputs/${O}/sync`, fede.cookie);
await memberDoc.ready();
check(memberDoc.text('document.md')?.toString() === 'Original text.', '…and no member sees it either');
viewerDoc.close();
memberDoc.close();

/* -------------------------------------------- guests: one session, nothing else */

const P = (await req('/sessions', { method: 'POST', body: { title: `Client ${stamp}`, teamId: T }, jar: fede })).json;
const pbase = `/o/${P.ownerSlug}/s/${P.publicId}`;
const ginv = await req(`${pbase}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede });
check((await req(`/invites/${ginv.json.token}`)).json?.guest === true, 'the invite page knows it is a guest invite');
const dave = await signupWith(ginv.json.token, 'dave');
check(dave.status === 201, 'Dave signs up as a guest');
check((await req(pbase, { jar: dave.jar })).json?.me?.role === 'viewer', 'the guest sees that session, as a viewer');
check((await req(`${pbase}/messages`, { method: 'POST', body: { content: 'hi' }, jar: dave.jar })).status === 404, 'a guest cannot post');
check((await req(`/teams/${T}`, { jar: dave.jar })).status === 404, 'a guest learns nothing about the team');
check((await req(base, { jar: dave.jar })).status === 404, '…not even its team-visible sessions');
check(JSON.stringify((await req('/sessions', { jar: dave.jar })).json.map((x) => x.publicId)) === JSON.stringify([P.publicId]), 'a guest\'s list holds exactly one session');
check((await req(pbase, { jar: fede })).json.guests?.some((g) => g.userId === dave.id), 'the owner sees the guest listed');

const ginv2 = await req(`${pbase}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede });
await req(`/invites/${ginv2.json.token}/redeem`, { method: 'POST', jar: fede });
check((await req(pbase, { jar: fede })).json.me.role === 'owner', 'a member redeeming a guest invite stays a member');

check((await req(`${pbase}/guests/${dave.id}`, { method: 'DELETE', jar: fede })).status === 200, 'the owner removes the guest');
check((await req(pbase, { jar: dave.jar })).status === 404, '…and the session is a 404 to him at once');

/* ---------------------------------------- ending, with nothing to clean up */

await req(base, { method: 'PATCH', body: { visibility: 'private' }, jar: fede });
check((await req(base, { jar: alice.jar })).status === 404, 'back to private: the teammate gets 404 again');
await req(base, { method: 'PATCH', body: { visibility: 'team' }, jar: fede });
check((await req(base, { jar: alice.jar })).status === 200, 'team-visible again: she can read');
await req(`/teams/${T}/members/${alice.id}`, { method: 'DELETE', jar: fede });
check((await req(base, { jar: alice.jar })).status === 404, 'Alice leaves the team: the session is a 404 to her');

await req(`${base}/team`, { method: 'PUT', body: { teamId: null }, jar: fede });
check((await req(base, { jar: fede })).json.visibility === 'private', 'taking the session out of its team makes it private');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM22 checks passed');
// The Yjs test clients' awareness timers would keep the process alive (as in m12).
process.exit(0);
