/**
 * M47 acceptance: onboarding — the welcome, and Get started.
 *
 * A new account (joining a team by invite) starts unwelcomed, with Get started
 * derived from what it has really done: in a team with someone else, so
 * "Invite a teammate" is already ticked, and nothing else. Continue saves the
 * look and is remembered for the account; starting a room ticks step 2 and
 * names the room for step 3; Dismiss sticks. The migration marks accounts from
 * before M47 as welcomed. How the screens look, and pairing a real computer,
 * stay the manual test.
 *
 * Requires: the server on :9090 and the test account (_setup.mjs).
 */
import { existsSync, readFileSync } from 'node:fs';

const BASE = 'http://localhost:9090';
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

async function req(path, { method = 'GET', body, jar } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jar?.cookie ? { cookie: jar.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  if (jar && set) jar.cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}
const step = (g, id) => g.steps.find((s) => s.id === id);

/* ------------------------------------------------ 1. a new account, by invite */

const owner = {};
check((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: owner })).status === 200, 'the test account signs in');
const stamp = Date.now();
const team = await req('/teams', { method: 'POST', body: { name: `m47-${stamp}` }, jar: owner });
const teamId = team.json?.id ?? team.json?.team?.id;
const inv = await req(`/teams/${teamId}/invites`, { method: 'POST', body: {}, jar: owner });
const newbie = {};
const signup = await req('/auth/signup', {
  method: 'POST',
  body: { token: inv.json?.token, email: `new-m47-${stamp}@example.com`, password: 'password123', displayName: `new-${stamp}` },
  jar: newbie,
});
check(signup.status < 300 && !!newbie.cookie, 'someone new joins the team by invite');

check((await req('/me/getting-started')).status === 401, 'Get started is only about the signed-in person (401 without a login)');
let g = (await req('/me/getting-started', { jar: newbie })).json;
check(g?.welcomed === false, 'a new account has not been welcomed: the welcome comes first');
check(g?.dismissed === false && g?.steps?.map((s) => s.id).join() === 'computer,room,agent,invite,integration', 'Get started has its five steps, in order');
check(step(g, 'integration')?.optional === true && g.steps.filter((s) => s.optional).length === 1, 'only "Connect GitHub or Jira" is optional');
check(!step(g, 'computer').done && !step(g, 'room').done && !step(g, 'agent').done && !step(g, 'integration').done, 'nothing is ticked that they have not done');
check(step(g, 'invite').done, '"Invite a teammate" is ticked from the record: their team has someone besides them');
check(g.room === null, 'no room to bring an agent into yet');

/* ------------------------------------------------ 2. the welcome */

check((await req('/me/welcome', { method: 'POST', body: { theme: '../../etc' }, jar: newbie })).status === 400, 'A THEME THE INSTANCE DOES NOT OFFER IS REFUSED');
check(!(await req('/me/getting-started', { jar: newbie })).json.welcomed, '…and a refused Continue does not count as welcomed');
check((await req('/me/welcome', { method: 'POST', body: { theme: 'terminal', agents: ['vim'] }, jar: newbie })).status === 400, 'AN AGENT NOT IN THE REGISTRY IS REFUSED (2026-10-16)');
check(!(await req('/me/getting-started', { jar: newbie })).json.welcomed, '…and that does not count as welcomed either');
check((await req('/me/welcome', { method: 'POST', body: { theme: 'terminal', agents: ['antigravity', 'antigravity'] }, jar: newbie })).status === 400, 'the same agent twice is refused');
check((await req('/me/welcome', { method: 'POST', body: { theme: 'terminal', agents: ['antigravity'], wanted: ['bad\u0007name'] }, jar: newbie })).status === 400, 'a wished-for name with control characters is refused');
const welcomed = await req('/me/welcome', { method: 'POST', body: { theme: 'terminal', agents: ['antigravity', 'claude-code'], wanted: ['cursor', '  My own thing  ', 'cursor'] }, jar: newbie });
check(welcomed.status === 200, 'Continue with Terminal, having said you use Antigravity and Claude Code and wish for Cursor and your own thing (2026-10-17: SEVERAL)');
let gs = (await req('/me/getting-started', { jar: newbie })).json;
check(JSON.stringify(gs.agents) === '["antigravity","claude-code"]', 'THE AGENTS YOU USE ARE REMEMBERED on the account, in your order');
check(JSON.stringify(gs.wanted) === '["cursor","My own thing"]', 'THE ONES YOU WISH FOR TOO, trimmed, once each');
check((await req('/me/agents', { method: 'PUT', body: { agents: ['other'] }, jar: newbie })).status === 200 && JSON.stringify((await req('/me/getting-started', { jar: newbie })).json.agents) === '["other"]', '…and can be changed later (Your devices)');
check(JSON.stringify((await req('/me/getting-started', { jar: newbie })).json.wanted) === '["cursor","My own thing"]', 'changing the agents leaves the wishes alone');
check((await req('/me/agents', { method: 'PUT', body: { agents: ['emacs'] }, jar: newbie })).status === 400, 'changing it to something not in the registry is refused');
check((await req('/me/agents', { method: 'PUT', body: { agents: ['codex'], wanted: [] }, jar: newbie })).status === 200 && (await req('/me/getting-started', { jar: newbie })).json.wanted.length === 0, 'the wishes can be cleared');
const welcomeSrc = readFileSync('apps/web/src/pages/WelcomePage.tsx', 'utf8');
check(/Which agents do you use\?/.test(welcomeSrc) && /Pick a look\./.test(welcomeSrc) && welcomeSrc.indexOf('Which agents do you use?') < welcomeSrc.indexOf('Pick a look.'), 'THE WELCOME ASKS YOUR AGENTS, THEN THE LOOK');
check(/AGENT_TOOLS\.map\(/.test(welcomeSrc) && /Something else, or none yet/.test(welcomeSrc) && /role="checkbox"/.test(welcomeSrc), 'one card per registry tool, and something else; any number ticked');
check(/<AgentLogo id=\{id\} name=\{name\}/.test(welcomeSrc) && existsSync('apps/web/src/assets/agents/claude-code.svg') && existsSync('apps/web/src/assets/agents/codex.svg') && existsSync('apps/web/src/assets/agents/opencode.svg') && existsSync('apps/web/src/assets/agents/antigravity.svg'), 'EACH CARD CARRIES THE TOOL’S LOGO, one SVG per registry tool');
check(/Which others would you want Fabrikka to run\?/.test(welcomeSrc) && /WANTED_AGENTS\.map\(/.test(welcomeSrc) && /placeholder="Another one\? Its name"/.test(welcomeSrc), 'AND ASKS WHICH OTHERS YOU WOULD WANT: chips for the ones not run yet, and a line for another');
check(/<AgentChoice picked=\{agents\}/.test(readFileSync('apps/web/src/pages/DevicesPage.tsx', 'utf8')) && /<WantedChoice/.test(readFileSync('apps/web/src/pages/DevicesPage.tsx', 'utf8')), 'Your devices shows the same cards and wishes');
check(/case 'agents': \{/.test(readFileSync('apps/server/src/cli.ts', 'utf8')) && /`admin agents`/.test(readFileSync('docs/operations.md', 'utf8')), 'the admin counts who uses and wishes for what: `admin agents`');
check(/useState\(preferred \?\? 'claude-code'\)/.test(readFileSync('apps/web/src/pages/SessionPage.tsx', 'utf8')) && /useState\(preferred \?\? ''\)/.test(readFileSync('apps/web/src/pages/SessionPage.tsx', 'utf8')), 'Add my agent and Connect another way start on your agent');
check((await req('/me/getting-started', { jar: newbie })).json.welcomed === true, '…marks the account welcomed (so no other browser shows it)');
check((await req('/me/theme', { jar: newbie })).json?.theme === 'terminal', '…and saves the look to the account, the same setting as Appearance');

/* ------------------------------------------------ 3. steps follow what happens */

const room = await req('/sessions', { method: 'POST', body: { title: 'My first room' }, jar: newbie });
check(room.status < 300, 'they start a room');
g = (await req('/me/getting-started', { jar: newbie })).json;
check(step(g, 'room').done, '"Start a room" is ticked');
const roomJson = room.json?.session ?? room.json;
check(g.room?.publicId === roomJson?.publicId && !!g.room?.ownerSlug, '…and Get started names that room for "Bring your agent"');
check(!step(g, 'agent').done, '"Bring your agent" stays open until their own agent posts');

const before = (await req('/me/getting-started', { jar: owner })).json;
check(before?.welcomed !== undefined && before.dismissed !== undefined, 'every account has its own Get started');

/* ------------------------------------------------ 4. dismiss */

check((await req('/me/getting-started/dismiss', { method: 'POST', body: {}, jar: newbie })).status === 200, 'Dismiss');
check((await req('/me/getting-started', { jar: newbie })).json.dismissed === true, '…sticks for the account');
check((await req('/me/getting-started', { jar: owner })).json.dismissed === before.dismissed, "…and only for that account");

/* ------------------------------------------------ 5. nobody already here is stopped */

const migration = readFileSync('packages/db/migrations/0029_onboarding.sql', 'utf8');
check(/UPDATE "users" SET "welcomed_at" = now\(\)/.test(migration), 'the migration marks accounts from before M47 as welcomed');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM47 checks passed');
process.exit(0);
