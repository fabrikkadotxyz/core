/**
 * M24 acceptance: since you were away — catch-up and handoffs.
 *
 * Story S6: an incident worked overnight; the teammate who arrives later sees
 * the decisions and the open question without reading the timeline.
 * Story S7: an agent finishes and hands off by mentioning a person; it waits
 * in their "Waiting for you" until they open the session.
 * Built from the record: no model, nothing generated.
 *
 * The real-vendor half (Sentry/Grafana for S6, a real PR for S7) needs M18 and
 * a spawned run, and is part of the manual test.
 *
 * Requires: server on :9090 and an account.
 */
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
    body: { token, email: `${name}-m24-${stamp}@example.com`, password: 'password123', displayName: `${name}-${stamp}` },
    jar: j,
  });
  return { jar: j, id: r.json?.user?.id };
}

const S = (await req('/sessions', { method: 'POST', body: { title: `Checkout 500s ${stamp}` }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const alice = await signupWith((await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'alice');
const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `claude-${stamp}`, provider: 'claude-code' }, jar: fede })).json;

/* -------------------------------------------- first visit, then leave for the night */

check((await req(`${base}/catch-up`, { jar: alice.jar })).json?.firstVisit === true, 'a first visit has nothing to catch up on');
await req(`${base}/context`, { method: 'PATCH', body: { add: { questions: ['Is the retry storm limited to EU?'] } }, jar: fede });
await req(`${base}/seen`, { method: 'POST', jar: alice.jar });
let cu = (await req(`${base}/catch-up`, { jar: alice.jar })).json;
check(cu.firstVisit === false && cu.messages === 0 && cu.decisions.length === 0, 'right after looking, nothing has changed');

/* --------------------------------------------- S6: 2 a.m., Fede and his agent work */

await req(`${base}/messages`, { method: 'POST', body: { content: 'Errors began after the 14:02 deploy.' }, jar: fede });
await tool(mcpUrl, agent.token, 'update_session_context', {
  add_facts: ['500s come from the payments webhook handler'],
  add_decisions: ['Roll back the 14:02 deploy', 'Add an idempotency key to webhook retries'],
  add_questions: ['Do we need to refund the double charges?'],
  remove_questions: ['Is the retry storm limited to EU?'],
});
const doc = (await tool(mcpUrl, agent.token, 'create_output', { kind: 'doc', name: 'Incident report', content: 'Timeline:' })).value;
await tool(mcpUrl, agent.token, 'edit_output', { output_id: doc.id, append: '14:02 deploy; 14:20 rollback.' });
await tool(mcpUrl, agent.token, 'link', { url: 'https://acme.sentry.io/issues/77/', type: 'error', title: 'DuplicateCharge', status: 'resolved' });

/* ------------------------------------------------- eight hours later: Alice arrives */

cu = (await req(`${base}/catch-up`, { jar: alice.jar })).json;
check(JSON.stringify(cu.decisions) === JSON.stringify(['Roll back the 14:02 deploy', 'Add an idempotency key to webhook retries']), 'S6: Alice sees the decisions made while she was away');
check(cu.newQuestions.length === 1 && cu.newQuestions[0] === 'Do we need to refund the double charges?', 'S6: …and the one new open question');
check(cu.answeredQuestions.includes('Is the retry storm limited to EU?'), 'S6: …and that the question she left open was answered');
check(cu.facts.includes('500s come from the payments webhook handler'), 'S6: …and the facts established');
check(cu.outputs.some((o) => o.name === 'Incident report' && o.editors.includes(`claude-${stamp}`)), 'S6: …which outputs changed, and by whom');
check(cu.outputs.find((o) => o.name === 'Incident report')?.isNew === true, 'S6: …marking the ones created while she was away as new');
check(cu.links.some((l) => l.title === 'DuplicateCharge' && l.status === 'resolved'), 'S6: …and which links changed status');
check(cu.messages === 1, 'S6: …and how many messages she has not read');
check(cu.since && new Date(cu.since) < new Date(), 'the catch-up says since when');

await req(`${base}/seen`, { method: 'POST', jar: alice.jar });
cu = (await req(`${base}/catch-up`, { jar: alice.jar })).json;
check(cu.decisions.length === 0 && cu.newQuestions.length === 0 && cu.outputs.length === 0 && cu.messages === 0, 'once she has caught up, the catch-up is empty');
check((await req(`${base}/catch-up`, { jar: fede })).json.firstVisit === true, 'catch-up is per person: Fede has his own');

/* ---------------------------------------------------- S7: the agent hands off */

const handoff = await tool(mcpUrl, agent.token, 'post_message', {
  content: `@alice-${stamp} the migration is merged; one question is open in the context.`,
});
check(!handoff.error, 'S7: the agent hands off by mentioning Alice');
let waiting = (await req('/waiting', { jar: alice.jar })).json;
const item = waiting.find((w) => w.session.publicId === S.publicId);
check(!!item && item.from === `claude-${stamp}`, 'S7: it waits in Alice\'s list, from the agent');
check(item?.text.includes(`@alice-${stamp}`) && !item.text.includes('<@'), '…readable, with names rather than ids');
check(!(await req('/waiting', { jar: fede })).json.some((w) => w.session.publicId === S.publicId), 'it is in nobody else\'s list');
check((await req(`${base}/catch-up`, { jar: alice.jar })).json.mentions.length === 1, 'the session\'s catch-up shows the mention too');

await req(`${base}/seen`, { method: 'POST', jar: alice.jar });
waiting = (await req('/waiting', { jar: alice.jar })).json;
check(!waiting.some((w) => w.session.publicId === S.publicId), 'S7: once she opens the session, it leaves her list');

/* ------------------------------------------------------------ viewers too */

const guest = await signupWith((await req(`${base}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede })).json.token, 'guest');
check((await req(`${base}/seen`, { method: 'POST', jar: guest.jar })).status === 200, 'a guest can mark a session seen');
await tool(mcpUrl, agent.token, 'update_session_context', { add_decisions: ['Refund the double charges'] });
check((await req(`${base}/catch-up`, { jar: guest.jar })).json.decisions?.includes('Refund the double charges'), 'and gets a catch-up of their own');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM24 checks passed');
