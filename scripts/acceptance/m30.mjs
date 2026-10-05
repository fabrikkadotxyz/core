/**
 * M30 acceptance: team credentials, shared and marked as shared (ADR 0028).
 *
 * The upstream fixture reports which token it saw, so routing is proved: the
 * team's token where a member has none, their own where they do, and nothing at
 * all for someone not on the team — the confused deputy ADR 0004 exists to stop.
 *
 * Fede (the test account) owns team T. Alice joins T. Carol is invited into one of
 * T's sessions but is not on T.
 *
 * Requires: server on :9090, the test account, and FABRIKKA_ENCRYPTION_KEY set.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';

const API = 'http://localhost:9090/api';
const MCP = 'http://localhost:9090/mcp';
const UPSTREAM_PORT = 9192;
const UPSTREAM = `http://localhost:${UPSTREAM_PORT}/mcp`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};

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

async function req(path, { method = 'GET', body, jar: j } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(j?.headers ?? {}) },
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
  return { status: res.status, json, text };
}

function admin(args) {
  return new Promise((resolve, reject) => {
    const child = execFileCb('pnpm', ['admin', ...args], (e, o) => (e ? reject(e) : resolve(o)));
    child.stdin.end('');
  });
}

async function mcp(url, token, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.text();
  try {
    return body.includes('data: ') ? JSON.parse(body.split('data: ').pop()) : JSON.parse(body);
  } catch {
    return { error: { message: `HTTP ${res.status}` } };
  }
}

/** The agent's aggregated tools, by name, with their descriptions. */
async function toolMap(url, token) {
  const r = await mcp(url, token, 'tools/list');
  return new Map((r.result?.tools ?? []).map((t) => [t.name, t.description ?? '']));
}

async function callTool(url, token, name, args = {}) {
  const r = await mcp(url, token, 'tools/call', { name, arguments: args });
  if (r.error) return { error: r.error.message };
  const text = r.result?.content?.[0]?.text;
  if (r.result?.isError) return { error: text ?? 'tool error' };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: text };
  }
}

/* ------------------------------------------------------------------ setup */

const upstream = spawn('node', ['scripts/fixtures/upstream-mcp.mjs', String(UPSTREAM_PORT)], { stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((r) => setTimeout(r, 2500));

const stamp = Date.now();
const created = { sessions: [], emails: [] };
const fede = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  upstream.kill();
  process.exit(1);
}

async function signupWith(token, name) {
  const j = jar();
  const email = `${name}-m30-${stamp}@example.com`;
  created.emails.push(email);
  const r = await req('/auth/signup', { method: 'POST', body: { token, email, password: 'password123', displayName: `${name}-${stamp}` }, jar: j });
  return { jar: j, id: r.json?.user?.id };
}

async function session(title, teamId) {
  const S = (await req('/sessions', { method: 'POST', body: { title: `${title} ${stamp}`, ...(teamId ? { teamId } : {}) }, jar: fede })).json;
  created.sessions.push(`/o/${S.ownerSlug}/s/${S.publicId}`);
  return { base: `/o/${S.ownerSlug}/s/${S.publicId}`, mcp: `${MCP}/o/${S.ownerSlug}/s/${S.publicId}` };
}

const agent = async (s, who, name) =>
  (await req(`${s.base}/agents`, { method: 'POST', body: { displayName: `${name}-${stamp}`, provider: 'claude-code' }, jar: who })).json;

const grant = (s, tool, allowed = true) => req(`${s.base}/integrations/sentry/tools/${tool}`, { method: 'PUT', body: { allowed }, jar: fede });

const T = (await req('/teams', { method: 'POST', body: { name: `Platform ${stamp}` }, jar: fede })).json.id;
const alice = await signupWith((await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'alice');

/* ---------------------------------- 1. a team owner adds a team credential */

const TEAM_TOKEN = `team-upstream-${stamp}`;
const added = await req(`/teams/${T}/connections`, { method: 'POST', body: { slug: 'sentry', label: 'Sentry', url: UPSTREAM, credential: TEAM_TOKEN }, jar: fede });
check(added.status === 201 && added.json.hasCredential === true, 'a team owner adds a team connection');
check(!added.text.includes(TEAM_TOKEN), 'THE TEAM TOKEN IS NEVER RETURNED — only whether one is set');
const ownerView = await req(`/teams/${T}/connections`, { jar: fede });
check(ownerView.json.canManage === true && ownerView.json.connections[0]?.addedBy, 'the owner can manage it, and sees who added it');
check(!ownerView.text.includes(TEAM_TOKEN), 'listing team connections never exposes the token');
const stdio = await req(`/teams/${T}/connections`, { method: 'POST', body: { slug: 'local', url: 'npx -y some-mcp-server' }, jar: fede });
check(stdio.status === 400, 'a command is refused here too — http(s) only (ADR 0014)');

/* ------------------------------------- 2. members see it; only owners add */

const aliceView = await req(`/teams/${T}/connections`, { jar: alice.jar });
check(aliceView.status === 200 && aliceView.json.connections.some((c) => c.slug === 'sentry'), 'a member sees the team connection exists');
check(aliceView.json.canManage === false && aliceView.json.uses.length === 0, '…cannot manage it, and sees nobody’s uses');
check(!aliceView.text.includes(TEAM_TOKEN), '…and never sees the token');
const aliceAdd = await req(`/teams/${T}/connections`, { method: 'POST', body: { slug: 'ci', url: UPSTREAM, credential: 'x' }, jar: alice.jar });
check(aliceAdd.status === 403, 'A MEMBER CANNOT ADD A TEAM CREDENTIAL — owners only');
check((await req(`/teams/${T}/connections/sentry`, { method: 'DELETE', jar: alice.jar })).status === 403, 'nor remove one');

/* ------------------- 3. in a team session: present, but nothing granted */

const S = await session('Triage', T);
await req(`${S.base}/members`, { method: 'POST', body: { userId: alice.id }, jar: fede });
const carol = await signupWith((await req(`${S.base}/invites`, { method: 'POST', body: {}, jar: fede })).json.token, 'carol');
check((await req(`/teams/${T}/connections`, { jar: carol.jar })).status === 404, 'team connections are a 404 to Carol, who is not on the team');

const fedeAgent = await agent(S, fede, 'fede-agent');
const aliceAgent = await agent(S, alice.jar, 'alice-agent');
const carolAgent = await agent(S, carol.jar, 'carol-agent');

const fedeSetup = await req(`${S.base}/integrations`, { jar: fede });
check(fedeSetup.json.team?.some((t) => t.slug === 'sentry' && !t.overridden), "the session's Setup lists the team's connection, as shared");
check(!(await toolMap(S.mcp, aliceAgent.token)).has('sentry__list_issues'), 'ADDING A TEAM CREDENTIAL GRANTS NOTHING — tools stay default-deny');
const discovered = await req(`${S.base}/integrations/sentry/tools`, { jar: fede });
check(discovered.json?.some((t) => t.name === 'list_issues'), "its tools are discovered through the team's credential, for the grants UI");
await grant(S, 'list_issues');

/* ------------------- 4. a member's agent uses it, marked as shared */

let aliceTools = await toolMap(S.mcp, aliceAgent.token);
check(aliceTools.has('sentry__list_issues'), "after the grant, Alice's agent lists the tool");
check(/Platform \d+'s shared credential/.test(aliceTools.get('sentry__list_issues') ?? ''), "ITS DESCRIPTION SAYS IT USES THE TEAM'S SHARED CREDENTIAL");
check(!aliceTools.has('sentry__merge_pull_request'), 'an ungranted tool stays absent');
let call = await callTool(S.mcp, aliceAgent.token, 'sentry__list_issues', {});
check(call.value?.seen_token === TEAM_TOKEN, "UPSTREAM SAW THE TEAM'S TOKEN — Alice has none of her own");

/* ------------------- 5. her own credential wins */

const ALICE_TOKEN = `alice-upstream-${stamp}`;
await req(`${S.base}/integrations`, { method: 'POST', body: { slug: 'sentry', label: 'Sentry', url: UPSTREAM, credential: ALICE_TOKEN }, jar: alice.jar });
call = await callTool(S.mcp, aliceAgent.token, 'sentry__list_issues', {});
check(call.value?.seen_token === ALICE_TOKEN, 'HER OWN CREDENTIAL WINS — upstream saw Alice’s token, not the team’s');
aliceTools = await toolMap(S.mcp, aliceAgent.token);
check((aliceTools.get('sentry__list_issues') ?? '').includes('using your own credential'), 'and the description now says "your own"');
check((await req(`${S.base}/integrations`, { jar: alice.jar })).json.team?.find((t) => t.slug === 'sentry')?.overridden === true, 'her Setup says she uses her own');
await req(`${S.base}/integrations/sentry`, { method: 'DELETE', jar: alice.jar });
call = await callTool(S.mcp, aliceAgent.token, 'sentry__list_issues', {});
check(call.value?.seen_token === TEAM_TOKEN, "detaching hers falls back to the team's");

/* ------------------- 6. never for someone who is not on the team */

check(!(await toolMap(S.mcp, carolAgent.token)).has('sentry__list_issues'), "CAROL'S AGENT HAS NO SUCH TOOL — she's in the session, not on the team");
check(!!(await callTool(S.mcp, carolAgent.token, 'sentry__list_issues', {})).error, 'calling it by name is refused');
check(((await req(`${S.base}/integrations`, { jar: carol.jar })).json.team ?? []).length === 0, "her Setup doesn't list the team's connections");

/* ------------------- 7. never outside the team's sessions */

const P = await session('Personal');
const pAgent = await agent(P, fede, 'fede-personal');
await grant(P, 'list_issues');
check(!(await toolMap(P.mcp, pAgent.token)).has('sentry__list_issues'), "absent in Fede's personal session, even with the tool granted there");
const U = (await req('/teams', { method: 'POST', body: { name: `Other ${stamp}` }, jar: fede })).json.id;
const SU = await session('Other team', U);
const uAgent = await agent(SU, fede, 'fede-other');
await grant(SU, 'list_issues');
check(!(await toolMap(SU.mcp, uAgent.token)).has('sentry__list_issues'), "absent in another team's session, even for its owner");

/* ------------------- 8. leaving the team ends it on the next call */

check((await req(`/teams/${T}/members/${alice.id}`, { method: 'DELETE', jar: fede })).status === 200, 'Fede removes Alice from the team');
check(!(await toolMap(S.mcp, aliceAgent.token)).has('sentry__list_issues'), "her agent loses the tool on its next listing");
check(!!(await callTool(S.mcp, aliceAgent.token, 'sentry__list_issues', {})).error, 'and a call is refused');

/* ------------------- 9. who acted is recorded, for owners */

const uses = (await req(`/teams/${T}/connections`, { jar: fede })).json.uses;
const alices = uses.filter((u) => u.agent === `alice-agent-${stamp}`);
check(alices.length === 2 && alices.every((u) => u.toolName === 'list_issues' && u.ok && u.slug === 'sentry'), "THE OWNER SEES ALICE'S AGENT'S TWO CALLS — only those made with the team's token");
check(alices.every((u) => u.person === `alice-${stamp}` && u.session === `Triage ${stamp}`), 'each names the person behind the agent and the session');
check(!JSON.stringify(uses).includes('seen_token') && !JSON.stringify(uses).includes(TEAM_TOKEN), 'no arguments, results or tokens are kept');
check((await req(`/teams/${T}/connections`, { jar: alice.jar })).status === 404, 'off the team, Alice no longer sees the page');

/* ------------------- 10. removing it, or moving the session, ends it */

check((await callTool(S.mcp, fedeAgent.token, 'sentry__list_issues', {})).value?.seen_token === TEAM_TOKEN, "Fede's agent uses the team's token too");
check((await req(`/teams/${T}/connections/sentry`, { method: 'DELETE', jar: fede })).status === 200, 'Fede removes the team connection');
check(!(await toolMap(S.mcp, fedeAgent.token)).has('sentry__list_issues'), 'it is gone from the session at once');

await req(`/teams/${T}/connections`, { method: 'POST', body: { slug: 'sentry', url: UPSTREAM, credential: TEAM_TOKEN }, jar: fede });
check((await toolMap(S.mcp, fedeAgent.token)).has('sentry__list_issues'), 're-added, it is back — the grant was the session’s all along');
await req(`${S.base}/team`, { method: 'PUT', body: { teamId: null }, jar: fede });
check(!(await toolMap(S.mcp, fedeAgent.token)).has('sentry__list_issues'), 'moving the session out of the team ends it');

check((await toolMap(S.mcp, fedeAgent.token)).has('post_message'), "the session's own tools are untouched throughout");

/* ----------------------------------------------------------------- cleanup */

for (const base of created.sessions) await req(base, { method: 'DELETE', jar: fede });
await req(`/teams/${T}/connections/sentry`, { method: 'DELETE', jar: fede });
for (const email of created.emails) await admin(['delete-user', '--email', email]).catch(() => {});
upstream.kill();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM30 checks passed');
