/**
 * M48 acceptance: each organization has its own folders (ADR 0043).
 *
 * A real host (the built client, as M31 runs it) is paired, and told the
 * account's organizations. Then:
 *   - a folder is granted for an organization, and the same path for Personal;
 *     the same path twice for one scope, or an organization that isn't yours,
 *     is refused on the machine;
 *   - the server keeps each grant's organization, and Add my agent refuses a
 *     folder from another scope;
 *   - a room moving to another organization stops its agent;
 *   - leaving an organization drops its folders from the server.
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
  check(acmeGrant?.orgName === acme.name && personalGrant?.orgName === 'Personal', 'the host lists each folder with its organization');

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

  const mine = (await req('/sessions', { method: 'POST', body: { title: `Personal room ${stamp}` }, jar: me })).json;
  const wrong2 = await req(`/o/${mine.ownerSlug}/s/${mine.publicId}/agents/host`, { method: 'POST', body: { deviceId: dev.id, grantId: acmeGrant.id }, jar: me });
  check(wrong2.status === 400, "ACME'S FOLDER IS REFUSED IN A PERSONAL ROOM");

  /* ---------------------------------------------- the room moves */

  check((await req(`${base}/team`, { method: 'PUT', body: { teamId: client.id }, jar: me })).status === 200, 'the room moves to Client');
  check(!!(await until(async () => !['connected', 'idle'].includes(await status()))), "ITS AGENT STOPS: Acme's folder doesn't serve a Client room");

  /* ---------------------------------------------- leaving an organization */

  const inv = (await req(`/teams/${client.id}/invites`, { method: 'POST', body: {}, jar: me })).json;
  const other = {};
  await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m48-${stamp}@example.com`, password: 'password123', displayName: `m48-${stamp}` }, jar: other });
  const theirs = (await req('/teams', { method: 'POST', body: { name: `Theirs ${stamp}` }, jar: other })).json;
  const theirInv = (await req(`/teams/${theirs.id}/invites`, { method: 'POST', body: {}, jar: other })).json;
  check((await req(`/invites/${theirInv.token}/redeem`, { method: 'POST', body: {}, jar: me })).status === 200, 'the account joins a third organization');
  check(!!(await until(async () => (await state()).organizations.some((o) => o.id === theirs.id))), '…and the host learns it without restarting');
  check((await grant({ org: theirs.id })).status === 201, 'a folder is granted for it');
  check(!!(await until(async () => (await req('/devices', { jar: me })).json.find((x) => x.id === dev.id)?.grants.some((g) => g.org === theirs.id))), '…and reported');
  const meId = (await req('/auth/me', { jar: me })).json?.user?.id ?? (await req('/auth/me', { jar: me })).json?.id;
  check((await req(`/teams/${theirs.id}/members/${meId}`, { method: 'DELETE', jar: other })).status === 200, 'their owner removes the account');
  check(
    !!(await until(async () => !(await req('/devices', { jar: me })).json.find((x) => x.id === dev.id)?.grants.some((g) => g.org === theirs.id))),
    "THE FOLDER FOR AN ORGANIZATION YOU LEFT IS DROPPED BY THE SERVER",
  );
  const onMachine = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8')).grants.some((g) => g.org === theirs.id);
  check(onMachine, '…while it stays on the machine, for you to remove');
} finally {
  host.kill('SIGTERM');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM48 checks passed');
process.exit(0);
