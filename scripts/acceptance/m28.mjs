/**
 * M28 acceptance: the home — what the sidebar is built from.
 *
 * The sidebar is UI (verified in the browser), but it stands on server facts:
 *   - every session carries its team and when it was last active, and the list
 *     is most-recently-active first, so a new message moves a session up;
 *   - your connections live outside any session: list, add, remove;
 *   - a saved connection can be attached to a session by name alone, and
 *     removing it detaches it everywhere.
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

const stamp = Date.now();
const fede = jar();
if ((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede })).status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

/* --------------------------------------- team sessions, by recent activity */

const T = (await req('/teams', { method: 'POST', body: { name: `Home ${stamp}` }, jar: fede })).json.id;
const made = [];
for (let i = 1; i <= 6; i++) {
  made.push((await req('/sessions', { method: 'POST', body: { title: `S${i} ${stamp}`, teamId: T }, jar: fede })).json);
  await sleep(15);
}
const personal = (await req('/sessions', { method: 'POST', body: { title: `Mine ${stamp}` }, jar: fede })).json;

let list = (await req('/sessions', { jar: fede })).json;
// Sessions, not chats: since M29 every team also has #general (ADR 0026).
const teamOnes = () => list.filter((s) => s.team?.id === T && (s.kind ?? 'session') === 'session');
check(teamOnes().length === 6 && teamOnes().every((s) => s.lastActivityAt), 'every team session says when it was last active');
check(teamOnes()[0].title === `S6 ${stamp}`, 'with no messages yet, the newest session is first');
check(!teamOnes().slice(0, 5).some((s) => s.title === `S1 ${stamp}`), 'the oldest is not in the top 5');

await req(`/o/${made[0].ownerSlug}/s/${made[0].publicId}/messages`, { method: 'POST', body: { content: 'bump' }, jar: fede });
list = (await req('/sessions', { jar: fede })).json;
check(teamOnes()[0].title === `S1 ${stamp}`, 'a message moves the oldest session to the top');
check(list.find((s) => s.publicId === personal.publicId)?.team === null, 'a personal session has no team, so it shows whichever team is chosen');

/* ------------------------------------------------- personal integrations */

const unauth = await fetch(`${API}/me/connections`);
check(unauth.status === 401 || unauth.status === 404, 'connections need a signed-in user');
const slug = `demo${stamp}`.slice(0, 20);
// ADR 0043: for the organization whose room it's attached to below.
const saved = await req('/me/connections', { method: 'POST', body: { slug, url: 'https://mcp.example.test/mcp', label: 'Demo', teamId: T }, jar: fede });
check(saved.status === 201, 'a connection is saved outside any session');
check((await req('/me/connections', { method: 'POST', body: { slug: 'Bad Slug!', url: 'https://x.test' }, jar: fede })).status === 400, 'a bad name is refused');
check((await req('/me/connections', { method: 'POST', body: { slug: 'x', url: 'file:///etc/passwd' }, jar: fede })).status === 400, 'only http(s) servers');
let mine = (await req(`/me/connections?team=${T}`, { jar: fede })).json.connections.find((c) => c.slug === slug);
check(mine && mine.sessions === 0 && mine.hasCredential === false, 'it is listed, in no session yet, with no token');

const base = `/o/${made[1].ownerSlug}/s/${made[1].publicId}`;
let integ = (await req(`${base}/integrations`, { jar: fede })).json;
check(integ.available.some((c) => c.slug === slug), "a session's Setup offers it");
check((await req(`${base}/integrations`, { method: 'POST', body: { slug }, jar: fede })).status === 201, 'it attaches by name alone');
integ = (await req(`${base}/integrations`, { jar: fede })).json;
check(integ.mine.some((c) => c.slug === slug) && !integ.available.some((c) => c.slug === slug), '…and moves from offered to attached');
mine = (await req(`/me/connections?team=${T}`, { jar: fede })).json.connections.find((c) => c.slug === slug);
check(mine.sessions === 1, 'the integrations page counts the session it is in');
check((await req(`${base}/integrations`, { method: 'POST', body: { slug: 'nothing-like-this' }, jar: fede })).status === 400, 'attaching a connection you do not have is refused');

check((await req(`/me/connections/${slug}?team=${T}`, { method: 'DELETE', jar: fede })).status === 200, 'removing it on the page…');
integ = (await req(`${base}/integrations`, { jar: fede })).json;
check(!integ.mine.some((c) => c.slug === slug), '…detaches it from every session');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM28 checks passed');
