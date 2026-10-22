/**
 * M68 acceptance: Self is one person (ADR 0062).
 *
 * Against the server: an organization invite for Self is refused; one made
 * before (written straight into the database) is refused when opened, signed
 * in or signing up, and signing up through it makes no account; Self's
 * members are its person; an organization invite still works; a one-off
 * session in Self still takes a second person, who is not on Self. From the
 * source: Settings has no People in Self. The `organization` and `join`
 * checks are m46's (the gates fixture).
 *
 * Requires: the core server on :9090, Docker's Postgres (fabrikka-postgres),
 * the test account.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
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
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out.trim()))));
const sql = (q) => run('docker', ['exec', '-i', 'fabrikka-postgres', 'psql', '-U', 'fabrikka', '-d', 'fabrikka', '-tAc', q]);
const admin = (args) => run('pnpm', ['admin', ...args]);
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

const settings = read('apps/web/src/pages/SettingsPage.tsx');
check(/key: 'people'[^}]*notSelf: true/.test(settings) && /!t\.notSelf \|\| !team\?\.own/.test(settings), 'SETTINGS HAS NO PEOPLE PAGE IN SELF');
check(/team && !team\.own && <PageLink to="\/settings\/people"/.test(read('apps/web/src/shell/Sidebar.tsx')), '…nor a People link in the sidebar');
check(/if \(team && !team\.own\) return <Link className="button" to="\/settings\/people">Invite<\/Link>/.test(read('apps/web/src/components/GettingStarted.tsx')), "…and Getting started's Invite goes to a room in Self");

/* ------------------------------------------------ 2. the server */

const stamp = Date.now();
const created = [];
const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const me = (await req('/auth/me', { cookie: fede })).json.user;
const own = (await req('/teams', { cookie: fede })).json.find((t) => t.own);

try {
  const refused = await req(`/teams/${own.id}/invites`, { method: 'POST', body: {}, cookie: fede });
  check(refused.status === 400 && /Self is yours alone/.test(refused.json?.error ?? ''), 'AN ORGANIZATION INVITE FOR SELF IS REFUSED (400)');

  // An invite to Self from before M68, as the database could still hold one.
  const token = randomBytes(24).toString('base64url');
  await sql(`insert into session_invites (team_id, token_hash, role, created_by_user_id, expires_at) values ('${own.id}', '${createHash('sha256').update(token).digest('hex')}', 'member', '${me.id}', now() + interval '1 day')`);
  check((await req(`/invites/${token}`)).status === 404, 'an old invite to Self describes nothing');
  const email = `m68-a-${stamp}@example.com`;
  const signup = await req('/auth/signup', { method: 'POST', body: { token, email, password: 'm68-password', displayName: `m68a ${stamp}` } });
  check(signup.status === 400, 'SIGNING UP THROUGH IT IS REFUSED…');
  check((await sql(`select count(*) from users where email = '${email}'`)) === '0', '…and makes no account');

  const orgTeam = (await req('/teams', { method: 'POST', body: { name: `M68 ${stamp}` }, cookie: fede })).json;
  const orgInvite = (await req(`/teams/${orgTeam.id}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
  check(!!orgInvite?.token, 'an organization invite still works');
  const pat = await req('/auth/signup', { method: 'POST', body: { token: orgInvite.token, email: `m68-pat-${stamp}@example.com`, password: 'm68-password', displayName: `Pat ${stamp}` } });
  created.push(`m68-pat-${stamp}@example.com`);
  check(pat.status === 201 && pat.json?.team?.id === orgTeam.id, '…and Pat joins the organization through it');

  const redeem = await req(`/invites/${token}/redeem`, { method: 'POST', cookie: pat.cookie });
  check(redeem.status === 400 && redeem.json?.error === 'self', 'SIGNED IN, REDEEMING AN OLD INVITE TO SELF IS REFUSED (self)');
  const members = (await req(`/teams/${own.id}`, { cookie: fede })).json.members;
  check(members.length === 1 && members[0].userId === me.id, "SELF'S MEMBERS ARE ITS PERSON ONLY");

  // A one-off session (ADR 0053) still takes people, into that session only.
  const S = (await req('/sessions', { method: 'POST', body: { title: `M68 one-off ${stamp}`, visibility: 'private' }, cookie: fede })).json;
  const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
  const link = (await req(`${base}/invites`, { method: 'POST', body: { reusable: true }, cookie: fede })).json;
  const joined = await req(`/invites/${link.token}/redeem`, { method: 'POST', cookie: pat.cookie });
  check(joined.status === 200 && joined.json?.session?.publicId === S.publicId, 'A ONE-OFF SESSION IN SELF STILL TAKES A SECOND PERSON');
  check(!(await req('/teams', { cookie: pat.cookie })).json.some((t) => t.id === own.id), '…who is not on Self');

  await req(base, { method: 'DELETE', cookie: fede });
  await sql(`delete from teams where id = '${orgTeam.id}'`).catch(() => {});
} finally {
  await sql(`delete from session_invites where team_id = '${own.id}'`).catch(() => {});
  for (const e of created) await admin(['delete-user', '--email', e]).catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nM68 checks passed');
process.exit(failures ? 1 : 0);
