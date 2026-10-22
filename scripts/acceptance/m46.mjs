/**
 * M46 acceptance: a deployment can gate new accounts and a team's writes
 * (ADR 0041).
 *
 * Two servers. The core's own on :9090, which must gate nothing. And a fixture
 * deployment (scripts/fixtures/gates-server.mts) that caps accounts, gates any
 * team named "Gated…", gives every team a notice and records membership
 * changes. Both share the database.
 *
 * Requires: the core server on :9090, Docker's Postgres (fabrikka-postgres),
 * the test account (_setup.mjs).
 */
import { execFile, spawn } from 'node:child_process';

const CORE = 'http://localhost:9090';
const PORT = 9196;
const DEP = `http://localhost:${PORT}`;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function req(base, path, { method = 'GET', body, jar: j } = {}) {
  const res = await fetch(`${base}${path}`, {
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
  return { status: res.status, json };
}
async function tool(url, token, name, args = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const payload = body.includes('data: ') ? JSON.parse(body.split('data: ').pop()) : JSON.parse(body);
  const result = payload.result;
  if (payload.error || result?.isError) return { error: payload.error?.message ?? result?.content?.[0]?.text ?? 'error' };
  return { value: result?.content?.[0]?.text };
}
const run = (cmd, args, stdin = '') =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out)));
    child.stdin.end(stdin);
  });
const sql = (q) => run('docker', ['exec', '-i', 'fabrikka-postgres', 'psql', '-U', 'fabrikka', '-d', 'fabrikka', '-tAc', q]);
const admin = (args, stdin) => run('pnpm', ['admin', ...args], stdin);

const stamp = Date.now();
const accounts = Number((await sql('select count(*) from users')).trim());

/* --------------------------------------------- the fixture deployment, capped at one more account */

const deployment = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', '../../scripts/fixtures/gates-server.mts'], {
  cwd: 'apps/server',
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: DEP, FIXTURE_MAX_ACCOUNTS: String(accounts + 1) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
for (let i = 0; i < 60; i++) {
  if ((await fetch(`${DEP}/health`).catch(() => null))?.ok) break;
  await sleep(500);
}
const created = [];

try {
  const fede = jar();
  await req(DEP, '/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede });
  const gatedTeam = (await req(DEP, '/api/teams', { method: 'POST', body: { name: `Gated ${stamp}` }, jar: fede })).json;
  const openTeam = (await req(DEP, '/api/teams', { method: 'POST', body: { name: `Open ${stamp}` }, jar: fede })).json;

  /* ------------------------------------------- notices and membership */

  const teams = (await req(DEP, '/api/teams', { jar: fede })).json;
  const open = teams.find((t) => t.id === openTeam.id);
  check(open?.notice?.text === '1 member(s)' && open.notice.url === '/fixture-notice' && open.notice.tone === 'info', "A TEAM CARRIES THE DEPLOYMENT'S NOTICE");
  await sleep(300);
  let changes = (await req(DEP, '/api/fixture/members')).json;
  check(changes.some((c) => c.teamId === openTeam.id && c.members === 1), 'creating a team is reported, with its size');
  check((await req(DEP, `/api/fixture/role/${openTeam.id}/${(await req(DEP, '/api/auth/me', { jar: fede })).json.user.id}`)).json.role === 'owner', 'kit.teamRole reads a role');

  /* ------------------------------------------- the account cap, through an invite */

  const invite = (await req(DEP, `/api/teams/${openTeam.id}/invites`, { method: 'POST', body: {}, jar: fede })).json;
  const first = `m46-a-${stamp}@example.com`;
  created.push(first);
  const joined = await req(DEP, '/api/auth/signup', { method: 'POST', body: { token: invite.token, email: first, password: 'm46-password', displayName: `m46a${stamp}` } });
  check(joined.status === 201, 'under the cap, an invite still makes an account');
  await sleep(300);
  changes = (await req(DEP, '/api/fixture/members')).json;
  check(changes.some((c) => c.teamId === openTeam.id && c.members === 2), 'JOINING BY INVITE IS REPORTED, with the new size');

  const invite2 = (await req(DEP, `/api/teams/${openTeam.id}/invites`, { method: 'POST', body: {}, jar: fede })).json;
  const second = `m46-b-${stamp}@example.com`;
  const capped = await req(DEP, '/api/auth/signup', { method: 'POST', body: { token: invite2.token, email: second, password: 'm46-password', displayName: `m46b${stamp}` } });
  check(capped.status === 403 && capped.json?.error === 'Fixture is full: no new accounts.', "AT THE CAP, AN INVITE'S SIGN-UP IS REFUSED WITH THE DEPLOYMENT'S SENTENCE");
  check((await sql(`select count(*) from users where email = '${second}'`)).trim() === '0', '…and no account is made');
  const third = `m46-c-${stamp}@example.com`;
  created.push(third);
  await admin(['create-user', '--email', third, '--password-stdin'], 'm46-password');
  check((await sql(`select count(*) from users where email = '${third}'`)).trim() === '1', "THE OPERATOR'S CLI IS NEVER CAPPED");

  /* ------------------------------------------- writes in a gated team */

  const room = (await req(DEP, '/api/sessions', { method: 'POST', body: { title: `M46 ${stamp}`, teamId: openTeam.id }, jar: fede })).json;
  const base = `/api/o/${room.ownerSlug}/s/${room.publicId}`;
  const agent = (await req(DEP, `${base}/agents`, { method: 'POST', body: { displayName: `m46-agent-${stamp}`, provider: 'claude-code' }, jar: fede })).json;
  const mcp = `${DEP}/mcp/o/${room.ownerSlug}/s/${room.publicId}`;
  check((await req(DEP, `${base}/messages`, { method: 'POST', body: { content: 'before' }, jar: fede })).status === 201, 'in an ungated team, messages go through');
  check(!(await tool(mcp, agent.token, 'post_message', { content: 'agent before' })).error, '…and so do agents');

  const blocked = await req(DEP, '/api/sessions', { method: 'POST', body: { title: 'nope', teamId: gatedTeam.id }, jar: fede });
  check(blocked.status === 402 && blocked.json?.url === '/fixture-notice' && blocked.json?.gated === true && /room/.test(blocked.json.error), 'A NEW ROOM IN A GATED TEAM IS REFUSED: 402, the reason and its link');

  // ADR 0050: a room cannot be moved into a gated team; the fixture gates the room's own team instead.
  await req(DEP, `/api/fixture/gate/${openTeam.id}`, { method: 'POST', body: {} });
  const sent = await req(DEP, `${base}/messages`, { method: 'POST', body: { content: 'after' }, jar: fede });
  check(sent.status === 402 && /message/.test(sent.json?.error ?? ''), 'IN A GATED TEAM, SENDING A MESSAGE IS REFUSED (402)');
  check((await req(DEP, `${base}/messages`, { jar: fede })).status === 200, '…reading still works');
  check((await req(DEP, `${base}/seen`, { method: 'POST', body: {}, jar: fede })).status < 400, '…marking read still works');
  check((await req(DEP, `${base}/context`, { method: 'PATCH', body: { objective: 'x' }, jar: fede })).status === 402, '…editing context is refused');
  const agentSays = await tool(mcp, agent.token, 'post_message', { content: 'agent after' });
  check(/^Refused: Fixture gated this team/.test(agentSays.error ?? ''), "AN AGENT'S post_message IS A TOOL ERROR STARTING Refused:, with the reason");
  check(!(await tool(mcp, agent.token, 'read_messages', {})).error, '…and the agent can still read');
  check((await req(DEP, `/api/teams/${gatedTeam.id}/invites`, { method: 'POST', body: {}, jar: fede })).status === 402, 'inviting into a gated team is refused');

  /* ------------------------------------------- M68: creating and joining an organization */

  const fedeId = (await req(DEP, '/api/auth/me', { jar: fede })).json.user.id;
  const ownId = (await req(DEP, '/api/teams', { jar: fede })).json.find((t) => t.own)?.id;
  const ownInfo = (await req(DEP, `/api/fixture/team/${ownId}`)).json;
  check(ownInfo?.ownOfUserId === fedeId, "KIT.TEAM() SAYS WHOSE SELF A TEAM IS");
  check((await req(DEP, `/api/fixture/team/${openTeam.id}`)).json?.ownOfUserId === null, '…and null for an organization');

  const joinTeam = (await req(DEP, '/api/teams', { method: 'POST', body: { name: `Join ${stamp}` }, jar: fede })).json;
  const joinInvite = (await req(DEP, `/api/teams/${joinTeam.id}/invites`, { method: 'POST', body: {}, jar: fede })).json;
  await req(DEP, `/api/fixture/gate/${joinTeam.id}`, { method: 'POST', body: {} });
  const fourth = `m46-d-${stamp}@example.com`;
  const signupJoin = await req(DEP, '/api/auth/signup', { method: 'POST', body: { token: joinInvite.token, email: fourth, password: 'm46-password', displayName: `m46d${stamp}` } });
  check(signupJoin.status === 402 && /\(join\)/.test(signupJoin.json?.error ?? '') && signupJoin.json?.gated === true, 'A REFUSED JOIN, SIGNING UP THROUGH THE LINK, ANSWERS 402');
  check((await sql(`select count(*) from users where email = '${fourth}'`)).trim() === '0', '…and makes no account');
  const member = jar();
  await req(DEP, '/api/auth/login', { method: 'POST', body: { email: first, password: 'm46-password' }, jar: member });
  const redeemJoin = await req(DEP, `/api/invites/${joinInvite.token}/redeem`, { method: 'POST', body: {}, jar: member });
  check(redeemJoin.status === 402 && /\(join\)/.test(redeemJoin.json?.error ?? ''), 'A REFUSED JOIN, SIGNED IN, ANSWERS 402');
  check((await sql(`select uses from session_invites where team_id = '${joinTeam.id}'`)).trim() === '0', '…and the invite is not used up');
  await req(DEP, `/api/fixture/gate/${joinTeam.id}`, { method: 'DELETE' });
  check((await req(DEP, `/api/invites/${joinInvite.token}/redeem`, { method: 'POST', body: {}, jar: member })).json?.team?.id === joinTeam.id, '…so the same link works once the deployment allows it');

  await req(DEP, '/api/fixture/refuse-organizations', { method: 'POST', body: {} });
  const before = (await sql('select count(*) from teams')).trim();
  const refusedOrg = await req(DEP, '/api/teams', { method: 'POST', body: { name: `Refused ${stamp}` }, jar: fede });
  check(refusedOrg.status === 402 && refusedOrg.json?.error === 'Fixture refuses new organizations.' && refusedOrg.json?.url === '/fixture-notice', 'A REFUSED NEW ORGANIZATION ANSWERS 402, with the reason and link');
  check((await sql('select count(*) from teams')).trim() === before, '…and makes no organization');

  /* ------------------------------------------- the core alone */

  const coreFede = jar();
  await req(CORE, '/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: coreFede });
  check((await req(CORE, `${base}/messages`, { method: 'POST', body: { content: 'core' }, jar: coreFede })).status === 201, 'THE CORE ALONE GATES NOTHING: the same room takes messages');
  const coreTeams = (await req(CORE, '/api/teams', { jar: coreFede })).json;
  check(coreTeams.every((t) => !t.notice), '…and shows no notices');
  const coreOrg = await req(CORE, '/api/teams', { method: 'POST', body: { name: `Core ${stamp}` }, jar: coreFede });
  check(coreOrg.status === 201, '…and refuses no new organization');
  if (coreOrg.json?.id) await sql(`delete from teams where id = '${coreOrg.json.id}'`).catch(() => {});

  /* ------------------------------------------- cleanup */

  await req(CORE, `${base}`, { method: 'DELETE', jar: coreFede });
  for (const t of [gatedTeam, openTeam, joinTeam]) await sql(`delete from teams where id = '${t.id}'`).catch(() => {});
} finally {
  for (const e of created) await admin(['delete-user', '--email', e]).catch(() => {});
  deployment.kill();
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM46 checks passed');
process.exit(0);
