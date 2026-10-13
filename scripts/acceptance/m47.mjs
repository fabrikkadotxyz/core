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
import { readFileSync } from 'node:fs';

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
check((await req('/me/welcome', { method: 'POST', body: { theme: 'terminal' }, jar: newbie })).status === 200, 'Continue with Terminal');
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
