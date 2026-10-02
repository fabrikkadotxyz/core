/**
 * M13 acceptance: LaTeX papers, compiled in the browser (ADR 0020).
 *
 * The compile itself happens in a browser and is covered by the manual test.
 * What is checked here is everything the server is responsible for:
 *   - `latex` is offered exactly when the TeX assets are installed;
 *   - the assets are served raw, cacheable, and nothing outside them is;
 *   - a paper is several files, and appending to a new path creates one;
 *   - a build report counts only for the source it was made against, and
 *     anything else is "unknown" — never "passed";
 *   - renaming a paper keeps its \title in step.
 *
 * Requires: server on :9090 and an account. With `pnpm tex:install` done, the
 * full set runs; without it, only the "absent, not broken" half does.
 */
import { createHash } from 'node:crypto';
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
    sendText: (s) => ws.send(s),
    async ready() {
      for (let i = 0; i < 50 && !state.synced && !state.error && !state.closed; i++) await sleep(50);
      return state.synced;
    },
    close: () => ws.close(),
  };
}

const stamp = Date.now();

const fede = jar();
if (
  (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede }))
    .status !== 200
) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}
const S = (await req('/sessions', { method: 'POST', body: { title: `Paper ${stamp}` }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (
  await req(`${base}/agents`, { method: 'POST', body: { displayName: `author-${stamp}`, provider: 'claude-code' }, jar: fede })
).json;

const kinds = (await req(`${base}/output-kinds`, { jar: fede })).json;
const latex = kinds.find((k) => k.kind === 'latex');
const tex = (await req(`${base}/tex`, { jar: fede })).json;

/* ------------------------------------- 1. offered exactly when installed */

check(!!latex, 'the catalogue knows the LaTeX kind');
check(latex?.multiFile === true, 'it is a multi-file kind');
check(!!latex?.available === !!tex, 'it is available exactly when the TeX assets are installed');

if (!tex) {
  const refused = await tool(mcpUrl, agent.token, 'create_output', { kind: 'latex', name: 'x' });
  check(!!refused.error, 'without the assets, creating a paper is refused — absent, not broken');
  console.log('\nTeX assets not installed: run `pnpm tex:install` for the full M13 check.');
  finish();
}

/* ------------------------------------------------ 2. the assets */

const wasm = await fetch(`${ORIGIN}${tex.assetsPath}/pdflatex/emscripten/pdflatex.wasm`);
check(wasm.status === 200, 'the engine is served by the instance');
check(wasm.headers.get('content-type') === 'application/wasm', '…as application/wasm');
check(!wasm.headers.get('content-encoding'), '…raw: no Content-Encoding to double-decompress');
check(/immutable/.test(wasm.headers.get('cache-control') ?? ''), '…and cacheable forever (it is versioned)');
await wasm.arrayBuffer();
const lsr = await fetch(`${ORIGIN}${tex.assetsPath}/texmf/ls-R`);
check(lsr.status === 200, 'the long-tail index is served');
await lsr.text();
const escape = await fetch(`${ORIGIN}/tex-assets/..%2F..%2Fpackage.json`);
check(escape.status === 404, 'a path escaping the assets directory is 404');
await escape.text();

/* ------------------------------------- 3. a paper is several files */

const created = await tool(mcpUrl, agent.token, 'create_output', { kind: 'latex', name: 'Retry storms' });
check(!created.error, 'an agent creates a paper');
const P = created.value;
check(P.files.includes('main.tex') && P.files.includes('refs.bib'), 'it starts from a template with main.tex and refs.bib');

const main = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(main.value.format === 'latex', 'read_output says the format is latex');
check(/\\title\{Retry storms\}/.test(main.value.content), 'the template is titled with the paper name');
check(/\\cite\{knuth1984\}/.test(main.value.content), 'and cites its own refs.bib, so it compiles with a bibliography');

const appended = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: P.id,
  file: 'sections/method.tex',
  append: '\\section{Method}\nWe measured.\n',
});
check(!appended.error, 'appending to a file that does not exist creates it');
const listed = (await tool(mcpUrl, agent.token, 'list_outputs')).value.find((o) => o.id === P.id);
check(listed.files.includes('sections/method.tex'), 'the new file is listed');

const badName = await tool(mcpUrl, agent.token, 'edit_output', { output_id: P.id, file: '../x.tex', append: 'x' });
check(badName.error?.startsWith('invalid_edit'), 'a path that climbs out is refused');
const binary = await tool(mcpUrl, agent.token, 'edit_output', { output_id: P.id, file: 'figure.png', append: 'x' });
check(!!binary.error, 'a non-text file is refused — images come from artifacts');

const addMain = await req(`${base}/outputs/${P.id}/files`, { method: 'POST', body: { path: 'main.tex' }, jar: fede });
check(addMain.status === 400, 'a file that exists cannot be added again');
const rmMain = await req(`${base}/outputs/${P.id}/files?path=main.tex`, { method: 'DELETE', jar: fede });
check(rmMain.status === 400, 'the main file cannot be removed');
const add = await req(`${base}/outputs/${P.id}/files`, { method: 'POST', body: { path: 'appendix.tex' }, jar: fede });
check(add.status === 201, 'a member adds a file from the browser');
const rm = await req(`${base}/outputs/${P.id}/files?path=appendix.tex`, { method: 'DELETE', jar: fede });
check(rm.status === 200, '…and removes it');

/* ------------------------------ 4. build reports: never a false "passed" */

let r = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(r.value.build?.status === 'unknown', 'nobody has compiled it: build is unknown');
check(r.value.build?.viewers === 0, '…and the agent is told nobody is viewing');

const B = yclient(`${base}/outputs/${P.id}/sync`, fede.cookie);
check(await B.ready(), 'a browser opens the paper');

const hashOf = (doc) => {
  const pairs = [...doc.getMap('files').entries()]
    .map(([p, t]) => [p, t.toString()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
};
const report = (msg) => B.sendText(JSON.stringify({ type: 'build.report', ...msg }));

report({ sourceHash: 'not-the-source', status: 'ok', errors: [] });
await sleep(300);
r = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(r.value.build.status === 'unknown', 'a report for some other source is ignored');
check(r.value.build.viewers === 1, 'viewers counts the open browser');

report({ sourceHash: hashOf(B.doc), status: 'ok', errors: [] });
await sleep(300);
r = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(r.value.build.status === 'ok', 'a report for exactly this source is accepted');
check(r.value.build.version === r.value.version, '…and recorded against the current version');

await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: P.id,
  edits: [{ old_text: '\\section{Introduction}', new_text: '\\section{Introduction}\n\\undefinedmacro' }],
});
await sleep(300);
r = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(r.value.build.status === 'unknown', 'after an edit, the old "ok" no longer counts');

report({
  sourceHash: hashOf(B.doc),
  status: 'failed',
  errors: [{ file: 'main.tex', line: 15, message: 'Undefined control sequence' }],
});
await sleep(300);
r = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(r.value.build.status === 'failed', 'the agent learns it broke the build');
check(r.value.build.errors[0]?.line === 15, '…and on which line');

/* ------------------------------------------ 5. rename keeps \title */

await req(`${base}/outputs/${P.id}`, { method: 'PATCH', body: { name: 'Retry storms, revisited' }, jar: fede });
await sleep(200);
r = await tool(mcpUrl, agent.token, 'read_output', { output_id: P.id });
check(/\\title\{Retry storms, revisited\}/.test(r.value.content), 'renaming the paper renames its \\title');

B.close();
finish();

function finish() {
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nM13 acceptance: all checks passed');
  process.exit(0);
}
