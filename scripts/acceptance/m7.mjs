/**
 * M7 acceptance: notes that survive concurrent editing (M65, ADR 0059), and artifacts.
 *
 * The property that matters is the one ADR 0013 established and ADR 0059 keeps: an agent recording
 * what it learned must not delete what a human typed a minute earlier. That is
 * tested directly, as the exact interleaving that used to lose data.
 *
 * Requires: server on :9090 and an account.
 */
import { execFile as execFileCb } from 'node:child_process';

const API = 'http://localhost:9090/api';
const MCP = 'http://localhost:9090/mcp';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

function jar() {
  let cookie = '';
  return {
    get headers() {
      return cookie ? { cookie } : {};
    },
    capture(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        if (pair?.startsWith('fabrikka_session=')) cookie = pair;
      }
    },
  };
}

async function req(path, { method = 'GET', body, jar: j, raw } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(j?.headers ?? {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  j?.capture(res);
  const text = raw === 'binary' ? null : await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, res };
}

function admin(args, stdinValue) {
  return new Promise((resolve, reject) => {
    const child = execFileCb('pnpm', ['admin', ...args], (e, o) =>
      e ? reject(e) : resolve(o),
    );
    child.stdin.end(stdinValue ?? '');
  });
}

/** Call an MCP tool as the agent. */
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
  await req('/sessions', { method: 'POST', body: { title: `Context ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;

const agent = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'ctx-agent', provider: 'claude-code' },
    jar: fede,
  })
).json;
const token = agent.token;

/* ------------------------------------- 1. notes basics (M65, ADR 0059) */

const empty = await req(`${base}/notes`, { jar: fede });
check(Array.isArray(empty.json) && empty.json.length === 0, 'a fresh session has no notes');

await req(`${base}/notes`, {
  method: 'POST',
  body: { text: `Fix the webhook ${stamp}`, tag: 'goal' },
  jar: fede,
});
const withGoal = await req(`${base}/notes`, { jar: fede });
check(
  withGoal.json.length === 1 && withGoal.json[0].text === `Fix the webhook ${stamp}` && withGoal.json[0].tag === 'goal',
  'a note can be written from the browser, with a tag',
);
check(typeof withGoal.json[0].by === 'string' && typeof withGoal.json[0].at === 'string', 'it says who and when');

const agentRead = await tool(mcpUrl, token, 'get_notes');
check(
  agentRead.value[0]?.text === `Fix the webhook ${stamp}`,
  'an agent reads the note over MCP without being told it exists',
);

/* -------------------- 2. THE lost-update scenario */

// A human writes three things down.
for (const text of ['fact A', 'fact B', 'fact C']) {
  await req(`${base}/notes`, { method: 'POST', body: { text, tag: 'fact' }, jar: fede });
}

// The agent read the notes BEFORE the human's next edit — the stale read that
// used to cause silent loss when the record was a replaceable list.
const staleRead = await tool(mcpUrl, token, 'get_notes');
check(staleRead.value.filter((n) => n.tag === 'fact').length === 3, 'the agent sees three facts');

// The human adds a fourth while the agent is thinking.
await req(`${base}/notes`, {
  method: 'POST',
  body: { text: 'fact D typed while the agent was thinking', tag: 'fact' },
  jar: fede,
});

// The agent records what it learned, the only way it can: append.
const appended = await tool(mcpUrl, token, 'add_note', {
  text: 'fact E discovered by the agent',
  tag: 'fact',
});
check(!appended.error, 'the agent appends a note');

const after = await req(`${base}/notes`, { jar: fede });
const texts = after.json.map((n) => n.text);
check(
  texts.includes('fact D typed while the agent was thinking'),
  "THE HUMAN'S NOTE SURVIVED — appending cannot lose a concurrent edit",
);
check(texts.includes('fact E discovered by the agent'), "the agent's note is there too");
check(after.json.filter((n) => n.tag === 'fact').length === 5, 'both edits are present, nothing displaced');

/* -------------------- 3. there is nothing to overwrite with */

const oldTool = await tool(mcpUrl, token, 'update_session_context', { facts: ['only this one'] });
check(!!oldTool.error, 'THE OLD REPLACE-A-LIST TOOL IS GONE: there is no blind overwrite to guard');
const badTag = await tool(mcpUrl, token, 'add_note', { text: 'tagged wrongly', tag: 'not a word!' });
check(!!badTag.error, 'a tag that is not one word is refused');
const spaced = await tool(mcpUrl, token, 'add_note', { text: 'tagged loosely', tag: 'Open Question' });
check(spaced.value?.tag === 'open-question', 'a tag is normalised to one lowercase word');

/* -------------------- 4. dedupe and removal by id */

await tool(mcpUrl, token, 'add_note', { text: 'ask for the CSV', tag: 'decision' });
await tool(mcpUrl, token, 'add_note', { text: 'ask for the CSV', tag: 'decision' });
const deduped = await req(`${base}/notes`, { jar: fede });
check(
  deduped.json.filter((n) => n.text === 'ask for the CSV').length === 1,
  'adding the same text twice does not duplicate it',
);

await tool(mcpUrl, token, 'add_note', { text: 'keep this one', tag: 'decision' });
const toRemove = deduped.json.find((n) => n.text === 'ask for the CSV');
const removal = await tool(mcpUrl, token, 'remove_note', { id: toRemove.id });
check(!removal.error, 'an agent removes a note by id');
const removed = await req(`${base}/notes`, { jar: fede });
const decisions = removed.json.filter((n) => n.tag === 'decision');
check(
  decisions.length === 1 && decisions[0].text === 'keep this one',
  'removal takes the right note and leaves the other',
);
const history = await req(`${base}/notes?removed=1`, { jar: fede });
const gone = history.json.find((n) => n.text === 'ask for the CSV');
check(gone && gone.removedAt && gone.removedBy === 'ctx-agent', 'REMOVAL IS SOFT: the history keeps the note, by whom and when');

/* ------------------------------------------- 5. artifacts */

const created = await tool(mcpUrl, token, 'create_artifact', {
  name: 'investigation.md',
  content: `# Investigation ${stamp}\n\nThe retry handler resets on 5xx.\n`,
});
check(!created.error, 'an agent can create an artifact');

const listed = await req(`${base}/artifacts`, { jar: fede });
check(
  listed.json.some((a) => a.name === 'investigation.md'),
  "the agent's artifact appears in the browser",
);
check(
  listed.json[0].createdBy.displayName === 'ctx-agent',
  'the artifact is attributed to the agent',
);

const agentList = await tool(mcpUrl, token, 'list_artifacts');
const readBack = await tool(mcpUrl, token, 'read_artifact', {
  artifact_id: agentList.value[0].id,
});
check(
  String(readBack.value).includes(`Investigation ${stamp}`),
  'an agent reads an artifact back',
);

// A human upload.
const form = new FormData();
form.append('file', new File([`col_a,col_b\n1,${stamp}\n`], 'items.csv', { type: 'text/csv' }));
const uploaded = await fetch(`${API}${base}/artifacts`, {
  method: 'POST',
  headers: { ...fede.headers },
  body: form,
});
check(uploaded.status === 201, 'a human can upload a file');

const afterUpload = await tool(mcpUrl, token, 'list_artifacts');
const csv = afterUpload.value.find((a) => a.name === 'items.csv');
check(!!csv, 'the uploaded file is visible to the agent');
const csvBody = await tool(mcpUrl, token, 'read_artifact', { artifact_id: csv.id });
check(
  String(csvBody.value).includes(String(stamp)),
  'the agent reads the uploaded CSV',
);

/* -------------------- 6. same filename, no clobbering */

for (const content of ['first version', 'second version']) {
  const f = new FormData();
  f.append('file', new File([content], 'notes.md', { type: 'text/markdown' }));
  await fetch(`${API}${base}/artifacts`, {
    method: 'POST',
    headers: { ...fede.headers },
    body: f,
  });
}
const notes = (await req(`${base}/artifacts`, { jar: fede })).json.filter(
  (a) => a.name === 'notes.md',
);
check(notes.length === 2, 'two files with the SAME NAME both exist');

const bodies = await Promise.all(
  notes.map(async (a) => {
    const r = await fetch(`${API}${base}/artifacts/${a.id}/content`, {
      headers: { ...fede.headers },
    });
    return r.text();
  }),
);
check(
  bodies.includes('first version') && bodies.includes('second version'),
  'NEITHER OVERWROTE THE OTHER — content addressing, not filenames',
);

/* -------------------- 7. links, and cross-session scoping */

const link = await req(`${base}/artifacts`, {
  method: 'POST',
  body: { name: 'the PR', url: 'https://github.com/example/repo/pull/182' },
  jar: fede,
});
check(link.status === 201 && link.json.type === 'link', 'a link artifact can be added');

const notAUrl = await req(`${base}/artifacts`, {
  method: 'POST',
  body: { name: 'bad', url: 'javascript:alert(1)' },
  jar: fede,
});
check(notAUrl.status === 400, 'a non-http URL is refused');

const other = (
  await req('/sessions', { method: 'POST', body: { title: `Other ${stamp}` }, jar: fede })
).json;
const otherBase = `/o/${other.ownerSlug}/s/${other.publicId}`;
const leak = await req(`${otherBase}/artifacts/${notes[0].id}/content`, { jar: fede });
check(
  leak.status === 404,
  "AN ARTIFACT ID FROM ANOTHER SESSION IS NOT READABLE — ids are not capabilities",
);

const contentDisposition = (
  await fetch(`${API}${base}/artifacts/${notes[0].id}/content`, {
    headers: { ...fede.headers },
  })
).headers.get('content-disposition');
check(
  contentDisposition?.includes('attachment'),
  'file content is served as an attachment, never inline',
);

/* ----------------------------------------------------- cleanup */

await req(base, { method: 'DELETE', jar: fede });
await req(otherBase, { method: 'DELETE', jar: fede });
void admin;

console.log(
  failures === 0 ? '\nM7 acceptance: PASS' : `\nM7 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
