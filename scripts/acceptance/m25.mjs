/**
 * M25 acceptance: session templates — a session's structure, never its content.
 *
 * Story S8: a product lead starts from *Shaping*; agents add rabbit holes and
 * draft the pitch; a reviewer comments; the bet is recorded as a decision.
 * Plus: saving a session copies exactly its structure — never messages, facts,
 * decisions, links, members or agents; team templates reach the team only;
 * built-ins can't be deleted.
 *
 * Requires: server on :9090 and an account.
 */
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
    body: { token, email: `${name}-m25-${stamp}@example.com`, password: 'password123', displayName: `${name}-${stamp}` },
    jar: j,
  });
  return { jar: j, id: r.json?.user?.id };
}

/* -------------------------------------------------------- the built-ins */

const templates = (await req('/templates', { jar: fede })).json;
for (const name of ['Shaping', 'Incident', 'Onboarding']) {
  check(templates.some((t) => t.name === name && t.source === 'builtin'), `Fabrikka ships the ${name} template`);
}
check((await req('/templates/builtin:shaping', { method: 'DELETE', jar: fede })).status === 404, 'a built-in cannot be deleted');

/* ------------------------------------------------------- S8: shaping a pitch */

const S = (await req('/sessions', { method: 'POST', body: { title: `Bulk export ${stamp}`, templateRef: 'builtin:shaping' }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;
const ctx = (await req(`${base}/context`, { jar: fede })).json;
check(ctx.objective?.startsWith('Shape a pitch'), 'S8: the session starts with the Shaping objective');
check(ctx.constraints.some((c) => c.startsWith('Appetite')), 'S8: …an appetite to fill in');
check(ctx.questions.includes('What exactly is the problem, in one sentence?'), 'S8: …and the questions shaping starts from');
const outs = (await req(`${base}/outputs`, { jar: fede })).json;
const pitch = outs.find((o) => o.name === 'Pitch');
check(!!pitch, 'S8: …and a Pitch document');
check((await req(`${base}/template`, { jar: fede })).json?.body?.connections?.includes('issue tracker'), 'the session knows its template, and the connections it suggests');
check(ctx.facts.length === 0 && ctx.decisions.length === 0, 'a template brings structure, not content: no facts, no decisions');

const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `shaper-${stamp}`, provider: 'claude-code' }, jar: fede })).json;
const read = (await tool(mcpUrl, agent.token, 'read_output', { output_id: pitch.id })).value;
check(read.content.includes('## Rabbit holes') && read.content.includes('## No-gos'), 'S8: the agent reads the pitch\'s sections');
const drafted = await tool(mcpUrl, agent.token, 'edit_output', {
  output_id: pitch.id,
  edits: [
    { old_text: '## Problem\n', new_text: '## Problem\nCustomers export one invoice at a time.\n' },
    { old_text: '## Rabbit holes\n', new_text: '## Rabbit holes\n- Exports over 10k rows touch billing\n' },
  ],
});
check(!drafted.error, 'S8: the agent drafts the problem and adds a rabbit hole');
await tool(mcpUrl, agent.token, 'update_session_context', { add_facts: ['Billing exports are rate-limited'] });

const reviewer = await signupWith((await req(`${base}/invites`, { method: 'POST', body: { role: 'guest' }, jar: fede })).json.token, 'reviewer');
check(
  (await req(`${base}/outputs/${pitch.id}/comments`, { method: 'POST', body: { quote: 'Exports over 10k rows touch billing', body: 'Then cap it at 10k for v1.' }, jar: reviewer.jar })).status === 200,
  'S8: a reviewer comments on the pitch',
);
await req(`${base}/context`, { method: 'PATCH', body: { add: { decisions: ['Bet 6 weeks on bulk export, capped at 10k rows'] } }, jar: fede });
check((await req(`${base}/context`, { jar: fede })).json.decisions.includes('Bet 6 weeks on bulk export, capped at 10k rows'), 'S8: the team bets, and the decision is recorded');
await req(`${base}/messages`, { method: 'POST', body: { content: 'Shaped and bet.' }, jar: fede });
await tool(mcpUrl, agent.token, 'link', { url: 'https://acme.atlassian.net/browse/EXP-1', type: 'issue', title: 'EXP-1' });

/* ---------------------------------------- save as template: structure only */

const saved = await req(`${base}/template`, { method: 'POST', body: { name: `Our shaping ${stamp}`, description: 'With our appetite rules' }, jar: fede });
check(saved.status === 201 && saved.json.source === 'mine', 'Fede saves the session as a template');
const body = saved.json.body;
check(body.objective.startsWith('Shape a pitch') && body.outputs.some((o) => o.name === 'Pitch' && o.content.includes('touch billing')), 'it keeps the objective and the documents as they stand');
check(body.connections.includes('issue tracker'), 'it keeps the suggested connections');
check(!JSON.stringify(body).includes('Billing exports are rate-limited'), 'it does not copy facts');
check(!JSON.stringify(body).includes('Bet 6 weeks'), '…or decisions');
check(!JSON.stringify(body).includes('EXP-1') && !JSON.stringify(body).includes('Shaped and bet'), '…or links, or messages');

const S2 = (await req('/sessions', { method: 'POST', body: { title: `Next pitch ${stamp}`, templateRef: saved.json.ref }, jar: fede })).json;
const base2 = `/o/${S2.ownerSlug}/s/${S2.publicId}`;
check((await req(`${base2}/outputs`, { jar: fede })).json.some((o) => o.name === 'Pitch'), 'a new session from it starts with the pitch');
check((await req(`${base2}/messages`, { jar: fede })).json.length === 0, '…and no messages');
check((await req(`${base2}/members`, { jar: fede })).json.length === 1, '…and no members but its creator');
check((await req(`${base2}/agents`, { jar: fede })).json.length === 0, '…and no agents');
check((await req(`${base2}/links`, { jar: fede })).json.length === 0, '…and no links');

/* ----------------------------------------------------------- team templates */

const T = (await req('/teams', { method: 'POST', body: { name: `Product ${stamp}` }, jar: fede })).json.id;
const pm = await signupWith((await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'pm');
const teamSaved = await req(`${base}/template`, { method: 'POST', body: { name: `Team shaping ${stamp}`, teamId: T }, jar: fede });
check(teamSaved.status === 201 && teamSaved.json.source === 'team', 'a template can be saved for a team');
check((await req('/templates', { jar: pm.jar })).json.some((t) => t.ref === teamSaved.json.ref), 'a teammate sees it');
check(!(await req('/templates', { jar: pm.jar })).json.some((t) => t.ref === saved.json.ref), "…but not Fede's personal one");
check((await req('/sessions', { method: 'POST', body: { title: 'x', templateRef: saved.json.ref }, jar: pm.jar })).status === 404, "and cannot start from someone else's");
check((await req('/sessions', { method: 'POST', body: { title: `PM's pitch ${stamp}`, templateRef: teamSaved.json.ref }, jar: pm.jar })).status === 201, 'the teammate starts a session from the team template');
check((await req(`/templates/${teamSaved.json.ref}`, { method: 'DELETE', jar: pm.jar })).status === 404, 'a team member cannot delete the team template');
check((await req(`/templates/${saved.json.ref}`, { method: 'DELETE', jar: fede })).status === 200, 'its owner deletes a template');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM25 checks passed');
