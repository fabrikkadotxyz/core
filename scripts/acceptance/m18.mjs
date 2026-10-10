/**
 * M18 acceptance: connections over OAuth, against local fake vendors
 * (scripts/fixtures/fake-oauth-mcp.mjs) shaped like the real first wave.
 *
 * Proves Fabrikka's side of the MCP authorization spec end to end:
 *   - discovery, dynamic registration (reused per instance) and a pre-registered
 *     client from the environment;
 *   - PKCE and `state`: forged, reused and someone else's states are refused;
 *   - one connection behind two entries; a field sent as a header;
 *   - presets over per-tool grants; tokens never returned;
 *   - refresh before expiry; a revoked refresh → needs reconnecting → reconnect.
 * Real vendors are verified by hand, entry by entry, before they're listed.
 *
 * Requires: the core server on :9090 (only for the shared database), the test
 * account, FABRIKKA_ENCRYPTION_KEY in .env, Docker's fabrikka-postgres.
 */
import { execFile, spawn } from 'node:child_process';

const PORT = 9213;
const INST = `http://localhost:${PORT}`;
const A = 9211;
const B = 9212;
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
const run = (cmd, args, stdin = '') =>
  new Promise((ok, fail) => {
    const child = execFile(cmd, args, (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out)));
    child.stdin.end(stdin);
  });
const sql = (q) => run('docker', ['exec', '-i', 'fabrikka-postgres', 'psql', '-U', 'fabrikka', '-d', 'fabrikka', '-tAc', q]);

/* ------------------------------------------------ fake vendors + a deployment */

// Each in its own process group: `npx tsx` starts children of its own, and
// killing the wrapper alone would leave the server running.
const procs = [
  spawn('node', ['scripts/fixtures/fake-oauth-mcp.mjs', String(A)], { stdio: 'ignore', detached: true }),
  spawn('node', ['scripts/fixtures/fake-oauth-mcp.mjs', String(B), '--no-registration', '--client', 'pre-id:pre-secret'], { stdio: 'ignore', detached: true }),
  spawn('npx', ['tsx', '--env-file-if-exists=../../.env', '../../scripts/fixtures/catalogue-server.mts'], {
    cwd: 'apps/server',
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: INST, FAKE_A: String(A), FAKE_B: String(B), FAKE_PRE_CLIENT_ID: 'pre-id', FAKE_PRE_CLIENT_SECRET: 'pre-secret' },
    stdio: 'ignore',
    detached: true,
  }),
];
const stopAll = () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
};
for (let i = 0; i < 60; i++) {
  const up = await Promise.all([`${INST}/health`, `http://localhost:${A}/admin/stats`, `http://localhost:${B}/admin/stats`].map((u) => fetch(u).then((r) => r.ok).catch(() => false)));
  if (up.every(Boolean)) break;
  await sleep(500);
}
const stats = async (port) => (await fetch(`http://localhost:${port}/admin/stats`)).json();

async function signIn(email, password) {
  const r = await fetch(`${INST}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0];
}
const cookie = await signIn(EMAIL, PASSWORD);
const api = (path, init = {}, as = cookie) =>
  fetch(`${INST}/api${path}`, { ...init, redirect: 'manual', headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie: as } });
const json = async (path, init, as) => (await api(path, init, as)).json();

/** Start → the vendor's consent (automatic) → the callback URL, not yet visited. */
async function authorize(entry, fields) {
  const start = await json('/connections/oauth/start', { method: 'POST', body: JSON.stringify({ entry, fields }) });
  if (!start.authorizeUrl) return { error: start.error };
  const consent = await fetch(start.authorizeUrl, { redirect: 'manual' });
  return { authorizeUrl: start.authorizeUrl, callback: consent.headers.get('location') };
}
/** Visit the callback as someone; returns where Fabrikka sends the browser. */
const land = async (callback, as = cookie) => (await fetch(callback, { redirect: 'manual', headers: { cookie: as } })).headers.get('location') ?? '';
const connect = async (entry, fields) => {
  const a = await authorize(entry, fields);
  return a.callback ? land(a.callback) : `error=${a.error}`;
};
const slugs = ['fakehub', 'fakepre', 'fakesuite', 'fakegraf'];
for (const s of slugs) await api(`/me/connections/${s}`, { method: 'DELETE' });

/* ------------------------------------------------ 1. the catalogue */

const cat = await json('/connections/catalogue');
const offered = cat.entries.map((e) => e.id);
check(['fakehub', 'fakepre', 'faketracker', 'fakewiki', 'fakegraf'].every((id) => offered.includes(id)), 'the catalogue lists its vendors by category');
check(!offered.includes('fakeunset'), 'A VENDOR NEEDING A PRE-REGISTERED CLIENT IS ABSENT UNTIL THE INSTANCE HAS ONE');
check(cat.entries.filter((e) => e.id.startsWith('fake')).every((e) => e.preview === false), 'verified vendors are not marked preview');
check(cat.entries.filter((e) => e.id === 'linear').every((e) => e.preview === true), 'A PREPARED VENDOR (Linear) IS OFFERED ONLY AS A PREVIEW, and only where FABRIKKA_PREPARED_VENDORS names it');

/* ------------------------------------------------ 2. sign in: discovery, registration, PKCE */

const first = await authorize('fakehub');
const authUrl = new URL(first.authorizeUrl ?? 'http://x');
check(authUrl.searchParams.get('code_challenge_method') === 'S256' && !!authUrl.searchParams.get('code_challenge') && authUrl.searchParams.get('resource') === `http://localhost:${A}/mcp`, 'the sign-in uses PKCE (S256) and names the MCP server as the resource');
check(authUrl.searchParams.get('redirect_uri') === `${INST}/api/connections/oauth/callback`, "the vendor sends the browser back to this instance's own callback");
check((await land(first.callback)).includes('connected=fakehub'), 'CONNECT → consent → back in Fabrikka, connected');
check((await stats(A)).registrations === 1, 'Fabrikka registered itself with the vendor (dynamic registration)');
check((await land(first.callback)).includes('error='), 'THE SAME CALLBACK A SECOND TIME IS REFUSED (single-use state)');
check((await connect('fakehub')).includes('connected=fakehub') && (await stats(A)).registrations === 1, 'connecting again reuses the registration: one per instance, not per sign-in');

const forged = new URL(first.callback);
forged.searchParams.set('state', 'forged-state');
check((await land(forged.href)).includes('error='), 'A FORGED state IS REFUSED');

const otherEmail = `m18-other-${Date.now()}@example.com`;
await run('pnpm', ['admin', 'create-user', '--email', otherEmail, '--name', 'm18-other', '--password-stdin'], 'other-password');
const otherCookie = await signIn(otherEmail, 'other-password');
const mine = await authorize('fakehub');
check((await land(mine.callback, otherCookie)).includes('error='), "SOMEONE ELSE CAN'T FINISH YOUR SIGN-IN (state bound to its person)");
check((await land(mine.callback)).includes('connected=fakehub'), '…while you still can');

check((await connect('fakepre')).includes('connected=fakepre') && (await stats(B)).registrations === 0, 'a vendor without registration connects with the pre-registered client (GitHub-like)');

/* ------------------------------------------------ 3. shared connection, fields */

check((await connect('faketracker')).includes('connected=faketracker'), 'connecting the tracker…');
const after = await json('/connections/catalogue');
check(after.entries.find((e) => e.id === 'fakewiki')?.connected === true, '…connects the wiki too: ONE CONNECTION BEHIND TWO ENTRIES');
check((await json('/me/connections')).connections.filter((c) => c.slug === 'fakesuite').length === 1, '…as one connection, under one slug');

const noStack = await json('/connections/oauth/start', { method: 'POST', body: JSON.stringify({ entry: 'fakegraf', fields: {} }) });
check(/required/.test(noStack.error ?? ''), 'a required field must be filled in');
const plainHttp = await json('/connections/oauth/start', { method: 'POST', body: JSON.stringify({ entry: 'fakegraf', fields: { stack: 'http://internal.example' } }) });
check(/https/.test(plainHttp.error ?? ''), 'a field URL must be https');
check((await connect('fakegraf', { stack: 'https://mystack.example.net/path' })).includes('connected=fakegraf'), 'with its stack URL, it connects');

/* ------------------------------------------------ 4. in a session: presets, calls */

const S = await json('/sessions', { method: 'POST', body: JSON.stringify({ title: `M18 ${Date.now()}` }) });
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = await json(`${base}/agents`, { method: 'POST', body: JSON.stringify({ displayName: `m18-agent-${Date.now()}`, provider: 'claude-code' }) });
for (const slug of ['fakehub', 'fakegraf']) await api(`${base}/integrations`, { method: 'POST', body: JSON.stringify({ slug }) });
const mcp = async (method, params = {}) => {
  const r = await fetch(`${INST}/mcp${base}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${agent.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const t = await r.text();
  return JSON.parse(t.includes('data: ') ? t.split('data: ').pop() : t);
};
const tools = async () => ((await mcp('tools/list')).result?.tools ?? []).map((t) => t.name);
const call = async (name) => {
  const r = await mcp('tools/call', { name, arguments: {} });
  try {
    return JSON.parse(r.result?.content?.[0]?.text);
  } catch {
    return { error: r.error?.message ?? r.result?.content?.[0]?.text };
  }
};

check(!(await tools()).some((t) => t.startsWith('fakehub__')), 'connected and attached, it still grants nothing (default-deny)');
await api(`${base}/integrations/fakehub/preset`, { method: 'PUT', body: JSON.stringify({ preset: 'read' }) });
let t = await tools();
check(t.includes('fakehub__list_issues') && !t.includes('fakehub__merge_pull_request'), 'THE READ PRESET: read tools appear, the write tool stays absent');
await api(`${base}/integrations/fakehub/preset`, { method: 'PUT', body: JSON.stringify({ preset: 'write' }) });
check((await tools()).includes('fakehub__merge_pull_request'), 'Read & write adds it');
const seenToken = (await call('fakehub__list_issues')).token;
check(!!seenToken, "the call reaches the vendor with this person's OAuth token");
await api(`${base}/integrations/fakegraf/tools/whoami`, { method: 'PUT', body: JSON.stringify({ allowed: true }) });
check((await call('fakegraf__whoami')).stack === 'https://mystack.example.net', "the entry's field travels as its header, origin only");

const listing = JSON.stringify(await json('/me/connections')) + JSON.stringify(await json('/connections/catalogue')) + JSON.stringify(await json(`${base}/integrations`));
check(!/access_token|refresh_token|sealed/i.test(listing), 'NO API RETURNS A TOKEN');
const plain = (await sql(`select count(*) from mcp_servers where entry = 'fakehub' and (sealed_credential like '%${seenToken}%' or coalesce(sealed_refresh_token, '') like '%${seenToken}%')`)).trim();
check(plain === '0' && (await sql(`select count(*) from mcp_servers where entry = 'fakehub' and sealed_credential is not null and sealed_refresh_token is not null`)).trim() === '1', 'TOKENS ARE STORED SEALED: the token the vendor saw appears nowhere in the row');

/* ------------------------------------------------ 5. refresh, revoke, reconnect */

await fetch(`http://localhost:${A}/admin/ttl/62`, { method: 'POST' });
await connect('fakehub');
// A 62-second token enters the 60-second refresh-early window after ~2 seconds.
await sleep(2500);
const before = (await stats(A)).refreshes;
check(!!(await call('fakehub__list_issues')).token && (await stats(A)).refreshes > before, 'A TOKEN ABOUT TO EXPIRE IS REFRESHED BEFORE THE CALL, with no click');
await fetch(`http://localhost:${A}/admin/revoke-refresh`, { method: 'POST' });
await sleep(2500); // the refreshed token (62 seconds) is back inside the window
await call('fakehub__list_issues'); // its refresh fails now
check((await json('/me/connections')).connections.find((c) => c.slug === 'fakehub')?.status === 'needs_reconnect', 'A REVOKED REFRESH MARKS IT "NEEDS RECONNECTING", not silently empty');
check(!(await tools()).some((x) => x.startsWith('fakehub__')), "…and its tools are absent until then");
await fetch(`http://localhost:${A}/admin/ttl/3600`, { method: 'POST' });
check((await connect('fakehub')).includes('connected=fakehub') && (await json('/me/connections')).connections.find((c) => c.slug === 'fakehub')?.status === 'ok', 'Reconnect: one sign-in, and it works again');
check((await tools()).includes('fakehub__list_issues'), '…with its grants intact');

/* ------------------------------------------------ 6. the desktop app's handoff to the browser (ADR 0033) */

await api('/me/connections/fakehub', { method: 'DELETE' });
const ho = await json('/connections/oauth/start', { method: 'POST', body: JSON.stringify({ entry: 'fakehub', handoff: true }) });
const hoUrl = new URL(ho.handoffUrl ?? 'http://x');
const ticket = hoUrl.searchParams.get('t') ?? '';
check(hoUrl.origin === INST && hoUrl.pathname === '/api/connections/oauth/handoff' && !!ticket, 'the desktop app gets a handoff link on the instance itself');

const confirm = await fetch(hoUrl, { redirect: 'manual' }); // the default browser: no Fabrikka login
const confirmHtml = await confirm.text();
check(confirm.status === 200 && confirmHtml.includes(EMAIL) && confirmHtml.includes('method="post"'), 'THE BROWSER IS SHOWN WHICH ACCOUNT IT CONNECTS, and opening the link starts nothing');
const edited = `${ticket.slice(0, -4)}${ticket.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
check((await fetch(`${INST}/api/connections/oauth/handoff?t=${encodeURIComponent(edited)}`)).status === 400, 'AN EDITED OR FORGED TICKET IS REFUSED');

const cont = await fetch(`${INST}/api/connections/oauth/handoff`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ t: ticket }),
});
const bound = cont.headers.getSetCookie().find((c) => c.startsWith('fabrikka_oauth_state=')) ?? '';
check(
  cont.status === 302 && (cont.headers.get('location') ?? '').startsWith(`http://localhost:${A}`) &&
    /HttpOnly/i.test(bound) && /SameSite=Lax/i.test(bound) && /Path=\/api\/connections\/oauth\/callback/i.test(bound),
  "Continue binds this browser to the sign-in (an HttpOnly cookie for the callback only) and goes to the vendor",
);
const hoCallback = (await fetch(cont.headers.get('location') ?? 'http://x', { redirect: 'manual' })).headers.get('location') ?? '';
check((await fetch(hoCallback, { redirect: 'manual' })).status === 401, "A BROWSER WITH NEITHER THE BINDING NOR A LOGIN CAN'T FINISH IT");
check(
  (await fetch(hoCallback, { redirect: 'manual', headers: { cookie: 'fabrikka_oauth_state=another-sign-ins-state' } })).status === 400,
  'A BINDING FOR ANOTHER SIGN-IN IS REFUSED',
);
const finished = await fetch(hoCallback, { redirect: 'manual', headers: { cookie: bound.split(';')[0] } });
check(
  finished.status === 200 && /is connected/.test(await finished.text()) && finished.headers.getSetCookie().some((c) => /^fabrikka_oauth_state=;/.test(c)),
  'the bound browser finishes it, on a page that sends the person back to the app, and the binding is cleared',
);
check((await json('/me/connections')).connections.find((c) => c.slug === 'fakehub')?.status === 'ok', '…and the connection belongs to the account that started it');
check((await fetch(hoCallback, { redirect: 'manual', headers: { cookie: bound.split(';')[0] } })).status === 400, 'THE SAME HANDOFF CALLBACK A SECOND TIME IS REFUSED');

/* ----------------------------------------------------------------- cleanup */

await api(base, { method: 'DELETE' });
for (const s of slugs) await api(`/me/connections/${s}`, { method: 'DELETE' });
await run('pnpm', ['admin', 'delete-user', '--email', otherEmail]).catch(() => {});
await sql(`delete from oauth_clients where issuer like 'http://localhost:${A}%' or issuer like 'http://localhost:${B}%'`);
stopAll();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM18 checks passed');
process.exit(0);
