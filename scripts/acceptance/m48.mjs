/**
 * M48 acceptance: each organization has its own folders and connections (ADR 0043).
 *
 * A real host (the built client, as M31 runs it) is paired, and told the
 * account's organizations. Then:
 *   - a folder is granted for an organization, and the same path for Personal;
 *     the same path twice for one scope, or an organization that isn't yours,
 *     is refused on the machine;
 *   - the server keeps each grant's organization; an organization's room
 *     refuses any other folder, while a personal room takes any of yours;
 *   - a room moving to another organization stops its agent;
 *   - leaving an organization drops its folders from the server;
 *   - a personal connection is for all your rooms unless connected for one
 *     organization only (ADR 0043, amended 2026-10-14): an organization's room
 *     takes its own over the all-rooms one, any room takes the all-rooms one,
 *     and an organization-only one is refused elsewhere; one for an
 *     organization you left is listed to remove.
 * The Folders window's look and old bindings (`from_personal`) are the manual test.
 *
 * Requires: the server on :9090, the test account (_setup.mjs), and the
 * bridge built (pnpm --filter @fabrikka/bridge build).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'http://localhost:9090';
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
const until = async (f, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await sleep(150);
  }
  return null;
};

async function req(path, { method = 'GET', body, jar } = {}) {
  const res = await fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(jar?.cookie ? { cookie: jar.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  if (jar && set) jar.cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const stamp = Date.now();
const me = {};
check((await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: me })).status === 200, 'the test account signs in');
const acme = (await req('/teams', { method: 'POST', body: { name: `Acme ${stamp}` }, jar: me })).json;
const client = (await req('/teams', { method: 'POST', body: { name: `Client ${stamp}` }, jar: me })).json;
check(!!acme?.id && !!client?.id, 'two organizations, Acme and Client');

/* ------------------------------------------------ a real host, paired */

const home = mkdtempSync(join(tmpdir(), 'm48-host-'));
const repo = join(home, 'repo');
mkdirSync(repo);
const PORT = 17000 + Math.floor(Math.random() * 900);
const before = new Set(((await req('/devices', { jar: me })).json ?? []).map((d) => d.id));
const lines = [];
const host = spawn(process.execPath, ['packages/bridge/dist/cli.js', 'host', '--server', ORIGIN], {
  env: { ...process.env, FABRIKKA_HOST_HOME: home, FABRIKKA_HOST_PORT: String(PORT), FABRIKKA_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
host.stderr.on('data', (d) => lines.push(...String(d).split('\n')));
// The host's own page takes the secret from the link it prints, then a cookie.
let ctl = null;
let pageCookie = '';
const local = (path, init = {}) =>
  fetch(`${ctl.origin}${path}`, { ...init, headers: { cookie: pageCookie, origin: ctl.origin, 'content-type': 'application/json', ...(init.headers ?? {}) } });
const state = async () => (await local('/api/state')).json();
const grant = async (body) => local('/api/grants', { method: 'POST', body: JSON.stringify({ path: repo, policy: 'edit', ...body }) });

try {
  const code = (await until(() => lines.map((l) => /confirm the code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l)).find(Boolean)))?.[1];
  check((await req('/devices/pair/confirm', { method: 'POST', body: { code }, jar: me })).status === 200, 'a host is paired');
  const dev = await until(async () => (await req('/devices', { jar: me })).json.find((d) => !before.has(d.id) && d.online));
  check(!!dev, '…and online');
  const link = (await until(() => lines.map((l) => /(http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]+)/.exec(l)).find(Boolean)))?.[1];
  ctl = new URL(link);
  pageCookie = (await fetch(link, { redirect: 'manual' })).headers.getSetCookie()[0].split(';')[0];

  /* ---------------------------------------------- grants, per organization */

  const orgs = await until(async () => {
    const s = await state().catch(() => null);
    return s?.organizations?.some((o) => o.id === acme.id) && s.organizations.some((o) => o.id === client.id) ? s.organizations : null;
  });
  check(!!orgs, "the host learns the account's organizations, for the Folders window's For");

  const forAcme = await grant({ org: acme.id });
  check(forAcme.status === 201, 'the repo is granted For: Acme');
  check((await grant({ org: acme.id })).status === 400, 'the same folder twice for Acme is refused');
  const personal = await grant({ org: null, policy: 'read' });
  check(personal.status === 201, '…but for Personal, as Read only, it is another grant');
  check((await grant({ org: '00000000-0000-0000-0000-000000000000' })).status === 400, "AN ORGANIZATION THAT ISN'T YOURS IS REFUSED ON THE MACHINE");
  const s = await state();
  const acmeGrant = s.grants.find((g) => g.org === acme.id);
  const personalGrant = s.grants.find((g) => g.org === null);
  check(acmeGrant?.orgName === acme.name && /^Personal/.test(personalGrant?.orgName ?? ''), 'the host lists each folder with its organization (a Personal one as no longer used, M53)');

  const seen = await until(async () => {
    const d = (await req('/devices', { jar: me })).json.find((x) => x.id === dev.id);
    return d?.grants.length === 2 ? d.grants : null;
  });
  check(seen?.find((g) => g.id === acmeGrant.id)?.org === acme.id && seen?.find((g) => g.id === personalGrant.id)?.org === null, 'the server keeps each grant\'s organization');

  /* ---------------------------------------------- Add my agent, in scope */

  const room = (await req('/sessions', { method: 'POST', body: { title: `Acme room ${stamp}`, teamId: acme.id }, jar: me })).json;
  const base = `/o/${room.ownerSlug}/s/${room.publicId}`;
  const wrong = await req(`${base}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: personalGrant.id }, jar: me });
  check(wrong.status === 400 && /for Personal rooms/.test(wrong.json?.error ?? ''), 'A PERSONAL FOLDER IS REFUSED IN AN ACME ROOM, saying why');
  const bound = await req(`${base}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: acmeGrant.id }, jar: me });
  check(bound.status === 201, "Acme's folder is accepted in an Acme room");
  const agentName = bound.json?.agent?.displayName;
  const status = () => req(base, { jar: me }).then((r) => r.json?.participants.find((p) => p.displayName === agentName)?.status);
  check(!!(await until(async () => ['connected', 'idle'].includes(await status()))), '…and the host connects the agent');

  // M53 (ADR 0051): a room created with no organization named is in your own organization; it takes that organization's folders only.
  const ownOrg = (await req('/teams', { jar: me })).json.find((t) => t.own);
  const mine = (await req('/sessions', { method: 'POST', body: { title: `Own room ${stamp}` }, jar: me })).json;
  check(!!ownOrg && mine.team?.id === ownOrg.id, 'a room with no organization named lands in your own organization');
  const acmeInMine = await req(`/o/${mine.ownerSlug}/s/${mine.publicId}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: acmeGrant.id }, jar: me });
  check(acmeInMine.status === 400 && new RegExp(`for ${acme.name}`).test(acmeInMine.json?.error ?? ''), "ACME'S FOLDER IS REFUSED IN YOUR OWN ORGANIZATION'S ROOM, saying why");
  const personalInMine = await req(`/o/${mine.ownerSlug}/s/${mine.publicId}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: personalGrant.id }, jar: me });
  check(personalInMine.status === 400, 'a folder granted Personal serves no room any more (ADR 0051)');
  const forOwn = await grant({ org: ownOrg.id, policy: 'read' });
  check(forOwn.status === 201, 'the repo is granted For: your own organization');
  const ownGrant = await until(async () => (await req('/devices', { jar: me })).json.find((d) => d.id === dev.id)?.grants.find((g) => g.org === ownOrg.id));
  const inMine = await req(`/o/${mine.ownerSlug}/s/${mine.publicId}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: ownGrant.id }, jar: me });
  check(inMine.status === 201, '…and that folder is accepted there');
  const mineStatus = () =>
    req(`/o/${mine.ownerSlug}/s/${mine.publicId}`, { jar: me }).then((r) => r.json?.participants.find((p) => p.displayName === inMine.json?.agent?.displayName)?.status);
  check(!!(await until(async () => ['connected', 'idle'].includes(await mineStatus()))), '…and the host runs it there');

  /* ---------------------------------------------- the room cannot move (ADR 0050) */

  check((await req(`${base}/team`, { method: 'PUT', body: { teamId: client.id }, jar: me })).status === 404, 'the room cannot be moved to Client: there is no such endpoint (ADR 0050)');
  check(['connected', 'idle'].includes(await status()), "…so its agent keeps running where it was");

  /* ---------------------------------------------- connections, per organization */

  const conn = (teamId) => req('/me/connections', { method: 'POST', body: { slug: 'm48gh', label: `GitHub ${teamId ?? 'personal'}`, url: 'https://example.com/mcp', teamId }, jar: me });
  const forAcmeConn = await conn(acme.id);
  const forMeConn = await conn(null);
  check(forAcmeConn.status === 201 && forMeConn.status === 201 && forAcmeConn.json.id !== forMeConn.json.id, 'one vendor, two connections: one for Acme, one for Personal');
  check((await conn(acme.id)).json?.id === forAcmeConn.json.id, 'connecting it again for Acme replaces that one, not the other');
  check((await conn('00000000-0000-0000-0000-000000000000')).status === 404, "A CONNECTION FOR AN ORGANIZATION THAT ISN'T YOURS IS REFUSED");
  const listed = (await req(`/me/connections?team=${acme.id}`, { jar: me })).json?.connections ?? [];
  check(listed.some((c) => c.id === forAcmeConn.json.id) && !listed.some((c) => c.id === forMeConn.json.id), 'Integrations, For: Acme, lists only Acme\'s');

  const acmeRoom = (await req('/sessions', { method: 'POST', body: { title: `Acme work ${stamp}`, teamId: acme.id }, jar: me })).json;
  const ab = `/o/${acmeRoom.ownerSlug}/s/${acmeRoom.publicId}`;
  const offered = (await req(`${ab}/integrations`, { jar: me })).json?.available ?? [];
  check(offered.some((c) => c.id === forAcmeConn.json.id) && !offered.some((c) => c.id === forMeConn.json.id), 'an Acme room offers only Acme\'s connection to attach');
  const attached = await req(`${ab}/integrations`, { method: 'POST', body: { slug: 'm48gh' }, jar: me });
  check(attached.status === 201 && attached.json?.id === forAcmeConn.json.id, "attaching it there attaches Acme's, not the Personal one");
  check((await req(`${ab}/integrations`, { jar: me })).json?.mine?.[0]?.id === forAcmeConn.json.id, '…and that is the one the room resolves');
  const pb = `/o/${mine.ownerSlug}/s/${mine.publicId}`;
  const personalAttach = await req(`${pb}/integrations`, { method: 'POST', body: { slug: 'm48gh' }, jar: me });
  check(personalAttach.json?.id === forMeConn.json.id, 'a Personal room attaches the Personal one');
  const clientRoom = (await req('/sessions', { method: 'POST', body: { title: `Client work ${stamp}`, teamId: client.id }, jar: me })).json;
  const cb = `/o/${clientRoom.ownerSlug}/s/${clientRoom.publicId}`;
  const clientOffered = (await req(`${cb}/integrations`, { jar: me })).json?.available ?? [];
  check(clientOffered.some((c) => c.id === forMeConn.json.id) && !clientOffered.some((c) => c.id === forAcmeConn.json.id), "a Client room offers the all-rooms one, not Acme's");
  const clientAttach = await req(`${cb}/integrations`, { method: 'POST', body: { slug: 'm48gh' }, jar: me });
  check(clientAttach.status === 201 && clientAttach.json?.id === forMeConn.json.id, 'A CLIENT ROOM ATTACHES THE ALL-ROOMS ONE (ADR 0043, amended 2026-10-14)');
  check((await req(`${cb}/integrations`, { jar: me })).json?.mine?.some((m) => m.id === forMeConn.json.id), '…and resolves it');
  const onlyAcme = await req('/me/connections', { method: 'POST', body: { slug: 'm48only', label: 'Acme only', url: 'https://example.com/mcp', teamId: acme.id }, jar: me });
  const refused = await req(`${cb}/integrations`, { method: 'POST', body: { slug: 'm48only' }, jar: me });
  check(onlyAcme.status === 201 && refused.status === 400 && /another organization only/.test(refused.json?.error ?? ''), 'A CONNECTION FOR ACME ONLY IS REFUSED IN A CLIENT ROOM, and it says so');
  check(!((await req(`${pb}/integrations`, { jar: me })).json?.available ?? []).some((c) => c.id === onlyAcme.json.id), '…and a personal room does not offer it');
  const everyone = (await req('/me/connections', { jar: me })).json?.connections ?? [];
  check(everyone.some((c) => c.id === forMeConn.json.id) && everyone.some((c) => c.id === forAcmeConn.json.id) && everyone.some((c) => c.id === onlyAcme.json.id), 'Personal integrations lists every one with its scope');

  /* ---------------------------------------------- leaving an organization */

  const inv = (await req(`/teams/${client.id}/invites`, { method: 'POST', body: {}, jar: me })).json;
  const other = {};
  await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m48-${stamp}@example.com`, password: 'password123', displayName: `m48-${stamp}` }, jar: other });
  const theirs = (await req('/teams', { method: 'POST', body: { name: `Theirs ${stamp}` }, jar: other })).json;
  const theirInv = (await req(`/teams/${theirs.id}/invites`, { method: 'POST', body: {}, jar: other })).json;
  check((await req(`/invites/${theirInv.token}/redeem`, { method: 'POST', body: {}, jar: me })).status === 200, 'the account joins a third organization');
  check(!!(await until(async () => (await state()).organizations.some((o) => o.id === theirs.id))), '…and the host learns it without restarting');
  check((await grant({ org: theirs.id })).status === 201, 'a folder is granted for it');
  check((await conn(theirs.id)).status === 201, '…and a connection made for it');
  check(!!(await until(async () => (await req('/devices', { jar: me })).json.find((x) => x.id === dev.id)?.grants.some((g) => g.org === theirs.id))), '…and reported');
  const meId = (await req('/auth/me', { jar: me })).json?.user?.id ?? (await req('/auth/me', { jar: me })).json?.id;
  check((await req(`/teams/${theirs.id}/members/${meId}`, { method: 'DELETE', jar: other })).status === 200, 'their owner removes the account');
  check(
    !!(await until(async () => !(await req('/devices', { jar: me })).json.find((x) => x.id === dev.id)?.grants.some((g) => g.org === theirs.id))),
    "THE FOLDER FOR AN ORGANIZATION YOU LEFT IS DROPPED BY THE SERVER",
  );
  const left = (await req('/me/connections', { jar: me })).json;
  check(left?.orphaned?.some((c) => c.teamId === theirs.id), "the connection for the organization you left is listed to remove");
  check((await req(`/me/connections/m48gh?team=${theirs.id}`, { method: 'DELETE', jar: me })).status === 200, '…and removing it works');
  const onMachine = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8')).grants.some((g) => g.org === theirs.id);
  check(onMachine, '…while it stays on the machine, for you to remove');
} finally {
  host.kill('SIGTERM');
  // Leave no paired computer behind on the test account.
  for (const d of (await req('/devices', { jar: me })).json ?? []) {
    if (!before.has(d.id)) await req(`/devices/${d.id}`, { method: 'DELETE', jar: me });
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM48 checks passed');
process.exit(0);
