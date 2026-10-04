/**
 * M21 acceptance: teams — a list of people, and nothing else (ADR 0025).
 *
 * Story S3: a team, and a session just for yourself.
 * Story S4: a private session, then add a teammate — from the roster, no link.
 * Plus what the ADR promises:
 *   - team invites are the M1 links: single-use, and a second way to sign up;
 *   - a team is a 404 to anyone not on it; being on it reveals no sessions;
 *   - only a session owner adds from the roster, and only teammates;
 *   - leaving the team removes exactly the access the team gave;
 *   - a direct invite is the stronger grant and survives leaving the team;
 *   - moving a session out of its team removes team-granted members;
 *   - the last owner can't leave.
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
    body: { token, email: `${name}-m21-${stamp}@example.com`, password: 'password123', displayName: `${name}-${stamp}` },
    jar: j,
  });
  return { jar: j, res: r, id: r.json?.user?.id };
}

/* -------------------------------------------- S3: a team, and invites to it */

const team = await req('/teams', { method: 'POST', body: { name: `Payments ${stamp}` }, jar: fede });
check(team.status === 201 && team.json.role === 'owner', 'Fede creates a team and owns it');
const T = team.json.id;

const invA = await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede });
check(invA.status === 201 && invA.json.url.includes('/invite/'), 'a team owner gets an invite link');
const preview = await req(`/invites/${invA.json.token}`);
check(preview.json?.kind === 'team' && preview.json.title === `Payments ${stamp}`, 'the invite page says it is a team, by name');

const alice = await signupWith(invA.json.token, 'alice');
check(alice.res.status === 201 && alice.res.json.team?.id === T && !alice.res.json.session, 'Alice signs up through it and lands on the team');
const again = await signupWith(invA.json.token, 'mallory');
check(again.res.status === 400, 'the same team invite cannot be redeemed twice');

const invB = await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede });
const bob = await signupWith(invB.json.token, 'bob');
check(bob.res.status === 201, 'Bob joins too');

const roster = (await req(`/teams/${T}`, { jar: alice.jar })).json;
check(roster?.members?.length === 3 && roster.role === 'member', 'a member sees the roster, as a member');
check((await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: alice.jar })).status === 404, 'a member cannot create team invites');

// Carol is on no team: the team does not exist for her.
const lone = (await req('/sessions', { method: 'POST', body: { title: `Carol's ${stamp}` }, jar: fede })).json;
const loneInv = await req(`/o/${lone.ownerSlug}/s/${lone.publicId}/invites`, { method: 'POST', body: {}, jar: fede });
const carol = await signupWith(loneInv.json.token, 'carol');
check((await req(`/teams/${T}`, { jar: carol.jar })).status === 404, 'a team is a 404 to someone not on it');

const S = (await req('/sessions', { method: 'POST', body: { title: `Just me ${stamp}`, teamId: T }, jar: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
check((await req(base, { jar: alice.jar })).status === 404, 'S3: a session in the team is private — Alice gets 404');
check((await req(base, { jar: bob.jar })).status === 404, 'S3: …and so does Bob');
check(!(await req('/sessions', { jar: alice.jar })).json.some((x) => x.publicId === S.publicId), 'S3: it is not in Alice\'s session list');
check((await req(`${base}/team`, { jar: fede })).json?.id === T, 'the session knows its team');

/* ------------------------------------------ S4: add a teammate from the roster */

const offered = (await req(`${base}/roster`, { jar: fede })).json;
check(offered?.length === 2 && offered.some((m) => m.userId === alice.id), 'the roster offers the two teammates not yet in it');
check((await req(`${base}/members`, { method: 'POST', body: { userId: carol.id }, jar: fede })).status === 400, 'someone not on the team cannot be added from the roster');

const add = await req(`${base}/members`, { method: 'POST', body: { userId: alice.id }, jar: fede });
check(add.status === 201, 'S4: Fede adds Alice from the roster');
check((await req(base, { jar: alice.jar })).status === 200, 'S4: Alice is in — no link involved');
check((await req(`${base}/roster`, { jar: alice.jar })).status === 404, 'only the owner sees the roster');
check((await req(`${base}/members`, { method: 'POST', body: { userId: bob.id }, jar: alice.jar })).status === 404, 'only the owner adds from it');
const members = (await req(`${base}/members`, { jar: fede })).json;
check(members.find((m) => m.userId === alice.id)?.viaTeam === true, 'her access is marked as coming from the team');

/* ---------------------------------- leaving removes exactly what the team gave */

// Bob: added from the roster AND directly invited — the direct grant wins.
await req(`${base}/members`, { method: 'POST', body: { userId: bob.id }, jar: fede });
const direct = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
await req(`/invites/${direct.json.token}/redeem`, { method: 'POST', jar: bob.jar });
check((await req(`${base}/members`, { jar: fede })).json.find((m) => m.userId === bob.id)?.viaTeam === false, 'a direct invite makes Bob\'s access direct');

check((await req(`/teams/${T}/members/${alice.id}`, { method: 'DELETE', jar: fede })).status === 200, 'Fede removes Alice from the team');
check((await req(base, { jar: alice.jar })).status === 404, 'S4: Alice is out of the session — her access came from the team');
check((await req(`/teams/${T}`, { jar: alice.jar })).status === 404, '…and the team is a 404 to her now');

check((await req(`/teams/${T}/members/${bob.id}`, { method: 'DELETE', jar: bob.jar })).status === 200, 'Bob leaves the team himself');
check((await req(base, { jar: bob.jar })).status === 200, 'Bob keeps the session — he was invited to it directly');

const me = (await req('/auth/me', { jar: fede })).json;
const lastOwner = await req(`/teams/${T}/members/${me?.id ?? me?.user?.id}`, { method: 'DELETE', jar: fede });
check(lastOwner.status === 409, 'the last owner cannot leave the team');

/* ------------------------------------- moving the session out of its team */

const invC = await req(`/teams/${T}/invites`, { method: 'POST', body: {}, jar: fede });
const dan = await signupWith(invC.json.token, 'dan');
await req(`${base}/members`, { method: 'POST', body: { userId: dan.id }, jar: fede });
check((await req(base, { jar: dan.jar })).status === 200, 'Dan is added from the roster');
const out = await req(`${base}/team`, { method: 'PUT', body: { teamId: null }, jar: fede });
check(out.status === 200 && out.json === null, 'Fede takes the session out of the team');
check((await req(base, { jar: dan.jar })).status === 404, 'Dan, added by the team, goes with it');
check((await req(base, { jar: bob.jar })).status === 200, 'Bob, invited directly, stays');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM21 checks passed');
