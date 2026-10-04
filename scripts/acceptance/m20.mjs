/**
 * M20 acceptance: agents read what you upload.
 *
 *   - a PDF uploaded through the browser path is read by an agent, page by page;
 *   - start_page / max_pages window a long one, and say when they truncated;
 *   - a scan (no text layer) says so instead of returning an empty success;
 *   - a damaged PDF is a clear tool error;
 *   - text files still come back inline, unchanged from M7.
 *
 * The story (S5: Confluence + two repos + a PDF + tickets in an epic) needs M18's
 * vendor connections and is part of the manual test.
 *
 * Requires: server on :9090 and an account.
 */
import { makePdf } from '../fixtures/make-pdf.mjs';

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

async function upload(base, j, name, type, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${API}${base}/artifacts`, { method: 'POST', body: form, headers: j.headers });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

const stamp = Date.now();
const fede = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}
const S = (await req('/sessions', { method: 'POST', body: { title: `Uploads ${stamp}` }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (
  await req(`${base}/agents`, { method: 'POST', body: { displayName: `reader-${stamp}`, provider: 'claude-code' }, jar: fede })
).json;

/* ------------------------------------------------------ 1. a real PDF, read */

const spec = makePdf([
  'Payments spec. Webhooks must be idempotent.',
  'Retries use exponential backoff with jitter.',
  'Every charge carries an idempotency key.',
  'Appendix: error codes.',
]);
const up = await upload(base, fede, 'spec.pdf', 'application/pdf', spec);
check(up.status === 201 || up.status === 200, 'a PDF uploads through the browser path');
const id = up.json?.id;

let r = await tool(mcpUrl, agent.token, 'read_artifact', { artifact_id: id });
check(r.value?.content_type === 'application/pdf', 'the agent is told it is a PDF');
check(r.value?.total_pages === 4, 'and how many pages it has');
check(r.value?.pages?.[0]?.text === 'Payments spec. Webhooks must be idempotent.', 'it reads the text of page 1');
check(r.value?.pages?.length === 4 && r.value.truncated === false, 'all four pages, nothing truncated');

r = await tool(mcpUrl, agent.token, 'read_artifact', { artifact_id: id, start_page: 2, max_pages: 2 });
check(
  JSON.stringify(r.value?.pages?.map((p) => p.page)) === '[2,3]' && r.value.truncated === true,
  'start_page / max_pages window it, and say there is more',
);

/* ------------------------------------------------- 2. a scan, and a broken file */

const scan = await upload(base, fede, 'scan.pdf', 'application/pdf', makePdf([null, null]));
r = await tool(mcpUrl, agent.token, 'read_artifact', { artifact_id: scan.json?.id });
check(r.value?.pages?.length === 0 && /no text layer/.test(r.value?.note ?? ''), 'a scan says it has no text layer');

const broken = await upload(base, fede, 'broken.pdf', 'application/pdf', Buffer.from('%PDF-1.4 not really'));
r = await tool(mcpUrl, agent.token, 'read_artifact', { artifact_id: broken.json?.id });
check(/could not be read/.test(r.error ?? ''), 'a damaged PDF is a clear tool error');

/* ---------------------------------------------------- 3. M7 is unchanged */

const notes = await upload(base, fede, 'notes.md', 'text/markdown', Buffer.from('# Notes\nplain text'));
r = await tool(mcpUrl, agent.token, 'read_artifact', { artifact_id: notes.json?.id });
check(r.value === '# Notes\nplain text', 'a text file still comes back inline');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM20 checks passed');
