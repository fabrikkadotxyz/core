/**
 * M27 acceptance: export — the record is yours.
 *
 * Story S10: a long "Cloud exit" session — infra repo linked, bills uploaded and
 * read, one decision per managed service, a migration plan written together —
 * exported. The Markdown answers "why did we choose this" for every decision,
 * with who decided and when, and opens in any editor.
 * Plus: the owner only; every output's files, changes and comments; artifacts
 * byte-for-byte; session.json for programs; no activity, no tokens.
 *
 * Unzipped with the system `unzip`, as a person would.
 *
 * Requires: server on :9090, an account, and `unzip` on PATH.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return res.json();
}

const stamp = Date.now();
const fede = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}
const me = (await req('/auth/me', { jar: fede })).json.user;

/* --------------------------------------------------- S10: weeks of work */

const S = (await req('/sessions', { method: 'POST', body: { title: `Cloud exit ${stamp}` }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `planner-${stamp}`, provider: 'claude-code' }, jar: fede })).json;

await req(`${base}/context`, { method: 'PATCH', body: { objective: 'Move off managed cloud onto our own hardware' }, jar: fede });
await tool(mcpUrl, agent.token, 'link', { url: 'https://github.com/acme/infra', type: 'repo', title: 'infra' });
const bills = makePdf(['AWS bill, March: RDS 41,200 USD', 'S3 9,800 USD; CloudFront 6,100 USD']);
const art = await upload(base, fede, 'aws-bills.pdf', 'application/pdf', bills);
const readBills = await tool(mcpUrl, agent.token, 'read_artifact', { artifact_id: art.id });
check(readBills.value?.pages?.[0]?.text.includes('RDS 41,200'), 'S10: the agent reads the uploaded bills (M20)');

await tool(mcpUrl, agent.token, 'update_session_context', {
  add_decisions: ['RDS → Postgres on our own hardware, with streaming replicas', 'S3 → MinIO across two racks'],
});
await req(`${base}/context`, { method: 'PATCH', body: { add: { decisions: ['CloudFront → keep for now; revisit in Q3'] } }, jar: fede });
await req(`${base}/context`, { method: 'PATCH', body: { add: { questions: ['Who owns on-call for the new racks?'] } }, jar: fede });

const plan = (await tool(mcpUrl, agent.token, 'create_output', { kind: 'doc', name: 'Migration plan', content: '## Order\n1. Storage\n2. Databases\n' })).value;
await tool(mcpUrl, agent.token, 'edit_output', { output_id: plan.id, edits: [{ old_text: '2. Databases\n', new_text: '2. Databases (one replica first)\n' }] });
await req(`${base}/outputs/${plan.id}/comments`, { method: 'POST', body: { quote: '1. Storage', body: 'Storage first — agreed, least risky.' }, jar: fede });
await req(`${base}/messages`, { method: 'POST', body: { content: 'Kicking off the cloud exit.' }, jar: fede });
await tool(mcpUrl, agent.token, 'post_message', { content: 'Bills read: RDS is the biggest line.' });

/* -------------------------------------------------------------- export */

const res = await fetch(`${API}${base}/export`, { headers: fede.headers });
check(res.status === 200 && res.headers.get('content-type') === 'application/zip', 'the owner exports the session as a zip');
check(/filename\*=UTF-8''/.test(res.headers.get('content-disposition') ?? ''), 'the download keeps its real name');
const zipBytes = Buffer.from(await res.arrayBuffer());
const dir = mkdtempSync(join(tmpdir(), 'fabrikka-export-'));
writeFileSync(join(dir, 'export.zip'), zipBytes);
execFileSync('unzip', ['-q', 'export.zip'], { cwd: dir });

const readme = readFileSync(join(dir, 'README.md'), 'utf8');
check(readme.startsWith(`# Cloud exit ${stamp}`), 'README.md is the session, as one document');
check(readme.includes(`Exported by @${me.displayName}`), 'it says who exported it…');
check(/Exported by @[^\n]+ on \d{4}-\d\d-\d\d/.test(readme), '…and when');
check(readme.includes('## Objective') && readme.includes('Move off managed cloud'), 'it opens with the objective');
for (const [decision, who] of [
  ['RDS → Postgres on our own hardware, with streaming replicas', `planner-${stamp}`],
  ['S3 → MinIO across two racks', `planner-${stamp}`],
  ['CloudFront → keep for now; revisit in Q3', me.displayName],
]) {
  const line = readme.split('\n').find((l) => l.includes(decision)) ?? '';
  check(new RegExp(`@${who}, \\d{4}-\\d\\d-\\d\\d`).test(line), `S10: "${decision.slice(0, 24)}…" says who decided it, and when`);
}
check(readme.includes('Who owns on-call for the new racks?'), 'the open question is there');
check(readme.includes('[infra](https://github.com/acme/infra)'), 'the linked repo is there');
check(readme.includes('## Context history') && readme.includes(`@planner-${stamp} added a decision`), 'the context history is there, oldest first');
check(
  readme.indexOf('added a decision: RDS') < readme.indexOf('added a decision: S3') &&
    readme.indexOf('added a decision: S3') < readme.indexOf('added a decision: CloudFront'),
  '…in the order things happened, even within one write',
);

const planDir = join(dir, 'outputs', 'Migration plan');
check(readFileSync(join(planDir, 'document.md'), 'utf8').includes('2. Databases (one replica first)'), 'the plan is there at its current version');
const changes = readFileSync(join(planDir, 'CHANGES.md'), 'utf8');
check(changes.includes(`@planner-${stamp}`) && changes.includes('+2. Databases (one replica first)'), 'with its changes log: who, and the diff');
check(readFileSync(join(planDir, 'COMMENTS.md'), 'utf8').includes('Storage first — agreed'), 'and its comments');
check(Buffer.compare(readFileSync(join(dir, 'artifacts', 'aws-bills.pdf')), bills) === 0, 'the bills are there, byte for byte');
const timeline = readFileSync(join(dir, 'timeline.md'), 'utf8');
check(timeline.includes('Kicking off the cloud exit.') && timeline.includes(`**@planner-${stamp}**`), 'the timeline is there, with names');

const json = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
check(json.format === 'fabrikka-export/1' && json.exportedBy === me.displayName, 'session.json is there, for programs');
check(json.contextHistory.filter((h) => h.field === 'decisions').length === 3, '…with the context history');
check(json.outputs[0].files['document.md'].includes('one replica'), '…and the outputs');

const everything = readdirSync(dir, { recursive: true })
  .filter((f) => !String(f).endsWith('.zip') && !String(f).endsWith('.pdf'))
  .map((f) => { try { return readFileSync(join(dir, String(f)), 'utf8'); } catch { return ''; } })
  .join('\n');
check(!everything.includes(agent.token), 'no token appears anywhere in the export');
check(!/"activity"|activity_visible/.test(everything), 'agent activity is not exported');

/* ------------------------------------------------------- who may export */

const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', { method: 'POST', body: { token: inv.json.token, email: `alice-m27-${stamp}@example.com`, password: 'password123', displayName: `alice-${stamp}` }, jar: alice });
check((await fetch(`${API}${base}/export`, { headers: alice.headers })).status === 404, 'a member who is not the owner cannot export');
const ginv = await req(`${base}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede });
const guest = jar();
await req('/auth/signup', { method: 'POST', body: { token: ginv.json.token, email: `guest-m27-${stamp}@example.com`, password: 'password123', displayName: `guest-${stamp}` }, jar: guest });
check((await fetch(`${API}${base}/export`, { headers: guest.headers })).status === 404, '…nor can a guest');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM27 checks passed');
