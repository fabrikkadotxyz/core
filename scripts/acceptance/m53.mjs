/**
 * M53 acceptance: every session in an organization; individual sessions
 * (ADR 0051).
 *
 * Against the server: a new account has its own organization, listed first
 * and named after the person; a session created with no organization named
 * is in it; a session is individual while only its owner is in it and private,
 * and stops being so when someone joins or the organization reads along; the
 * own organization cannot be left; a direct message is still in none. From
 * the source: the sidebar's two headings and their two kinds of +, the
 * schema's check, the Folders window without Personal.
 *
 * Requires: the core server on :9090 and the test account.
 */
import { readFileSync } from 'node:fs';

const CORE = 'http://localhost:9090';
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
const read = (p) => readFileSync(p, 'utf8');

async function req(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(`${CORE}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  return { status: r.status, json, cookie: set ? set.split(';')[0] : undefined };
}

/* ------------------------------------------------ 1. the source */

const side = read('apps/web/src/shell/Sidebar.tsx');
check(/aria-label="Organization sessions"/.test(side) && /aria-label="Individual sessions"/.test(side) && !/Personal sessions/.test(side), 'the sidebar: Organization sessions and Individual sessions, no Personal');
check(/visibility="team" open=\{creating === 'team'\}/.test(side) && /visibility="private" open=\{creating === 'individual'\}/.test(side), 'the + beside Organization starts one the organization reads along; the + beside Individual, a private one');
check(/work\.filter\(\(s\) => s\.individual\)/.test(side) && /work\.filter\(\(s\) => !s\.individual\)/.test(side), 'both lists are the chosen organization\'s, split by individual');
check(/check\('sessions_in_organization', sql`\$\{t\.kind\} = 'direct' or \$\{t\.teamId\} is not null`\)/.test(read('packages/db/src/schema.ts')), 'THE SCHEMA HOLDS IT: a session or chat has an organization; only a direct message has none');
check(/ownOfUserId: uuid\('own_of_user_id'\)\.unique\(\)/.test(read('packages/db/src/schema.ts')), 'an account has at most one own organization');
check(!/name: 'Personal'/.test(read('apps/desktop/src/folders.html')) && !/name: 'Personal'/.test(read('packages/bridge/src/host/control.ts')), 'the Folders window and the host\'s page offer no Personal scope');
check(/Personal · no longer used/.test(read('packages/bridge/src/host/host.ts')), 'an older Personal folder is listed as no longer used');

/* ------------------------------------------------ 2. a new account has its own organization */

const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const teams = (await req('/teams', { cookie: fede })).json;
const own = teams.find((t) => t.own);
check(!!own && teams[0].own === true, 'THE TEST ACCOUNT HAS ITS OWN ORGANIZATION, listed first');

// A fresh account, through a session invite: born with its own organization, named after the person.
const S0 = (await req('/sessions', { method: 'POST', body: { title: `M53 host ${stamp}`, teamId: own.id }, cookie: fede })).json;
const inv = (await req(`/o/${S0.ownerSlug}/s/${S0.publicId}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
const alice = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m53-alice-${stamp}@example.com`, password: 'password123', displayName: `Alice ${stamp}` } });
check(alice.status === 201, 'Alice signs up through an invite');
const aliceTeams = (await req('/teams', { cookie: alice.cookie })).json;
check(aliceTeams.length === 1 && aliceTeams[0].own === true && aliceTeams[0].name === `Alice ${stamp}`, 'A NEW ACCOUNT IS BORN WITH ITS OWN ORGANIZATION, named after the person');
const aliceChats = (await req('/sessions', { cookie: alice.cookie })).json.filter((s) => s.kind === 'chat');
check(aliceChats.some((s) => s.team?.id === aliceTeams[0].id && s.title === 'general'), '…with a #general like any organization');

/* ------------------------------------------------ 3. sessions land in an organization */

const unnamed = (await req('/sessions', { method: 'POST', body: { title: `M53 unnamed ${stamp}` }, cookie: fede })).json;
check(unnamed.team?.id === own.id, 'A SESSION CREATED WITH NO ORGANIZATION NAMED IS IN YOUR OWN');
const list = () => req('/sessions', { cookie: fede }).then((r) => r.json);
let mine = (await list()).find((s) => s.publicId === unnamed.publicId);
check(mine?.individual === true, 'only you in it, private: INDIVIDUAL');
const orgOne = (await req('/sessions', { method: 'POST', body: { title: `M53 org ${stamp}`, teamId: own.id, visibility: 'team' }, cookie: fede })).json;
check((await list()).find((s) => s.publicId === orgOne.publicId)?.individual === false, 'started for the organization to read along: an ORGANIZATION SESSION from the start');
check((await req('/sessions', { method: 'POST', body: { title: 'x', visibility: 'public' }, cookie: fede })).status === 400, 'visibility is private or team');
check((await list()).filter((s) => !s.team && s.kind !== 'direct').length === 0, 'NO SESSION OR CHAT IS IN NO ORGANIZATION');

// Let someone in: it stops being individual.
const inv2 = (await req(`/o/${unnamed.ownerSlug}/s/${unnamed.publicId}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
await req(`/invites/${inv2.token}/redeem`, { method: 'POST', body: {}, cookie: alice.cookie });
mine = (await list()).find((s) => s.publicId === unnamed.publicId);
check(mine?.individual === false && mine.memberCount === 2, 'SOMEONE JOINS: it becomes an organization session');

// A direct message is in none, still.
const direct = await req('/directs', { method: 'POST', body: { userId: alice.json.user.id }, cookie: fede });
if (direct.status === 201 || direct.status === 200) check(direct.json.team === null || direct.json.team === undefined, 'a direct message between two people is in no organization');
else console.log('note  no direct chat possible here (' + direct.status + '): Fede and Alice share no organization');

/* ------------------------------------------------ 4. the own organization cannot be left */

const me = (await req('/auth/me', { cookie: fede })).json.user;
const leave = await req(`/teams/${own.id}/members/${me.id}`, { method: 'DELETE', cookie: fede });
check(leave.status === 409 && /your own organization/.test(leave.json?.error ?? ''), 'YOU CANNOT LEAVE YOUR OWN ORGANIZATION');
check(/own_of_user_id/.test(read('docs/data-model.md')) && /\[0051\]/.test(read('docs/decisions/README.md')), 'docs/data-model.md and the ADR index say so');

console.log(failures ? `\n${failures} FAILED` : '\nM53 checks passed');
process.exit(failures ? 1 : 0);
