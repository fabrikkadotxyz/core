/**
 * M58 acceptance: leaving (ADR 0057).
 *
 * Against the server: a person who owns an organization and a room other
 * people are in asks to delete their account with their password; they are
 * signed out everywhere; signing in during the grace period cancels it and
 * says so; asking again with "remove my name", then the operator's
 * `delete-user --now`, leaves their messages in the shared room under
 * `former-member`, marked deleted, passes the organization and the room to
 * the other member, and makes their sign-in fail like a wrong password. A
 * second person is deactivated and reactivated through the CLI. From the
 * source: the FK rules that stop a stray row delete, and the Account tab.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) and the test
 * account. Runs the admin CLI against the same database.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CORE = process.env.FABRIKKA_CORE ?? 'http://localhost:9090';
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
  return { status: r.status, json, cookie: set ? set.split(';')[0] : undefined, text };
}
const admin = (...args) => execFileSync('pnpm', ['--silent', 'admin', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/* ------------------------------------------------ 1. the source */

const schema = read('packages/db/src/schema.ts');
check(/createdByUserId: uuid\('created_by_user_id'\)\s*\.notNull\(\)\s*\.references\(\(\) => users\.id, \{ onDelete: 'restrict' \}\)/.test(schema), "A TEAM'S CREATOR NEVER CASCADES: restrict");
check(/ownOfUserId: uuid\('own_of_user_id'\)\.unique\(\)\.references\(\(\) => users\.id, \{ onDelete: 'restrict' \}\)/.test(schema), '…nor Self');
check(/ownerId: uuid\('owner_id'\)\s*\.notNull\(\)\s*\.references\(\(\) => users\.id, \{ onDelete: 'restrict' \}\)/.test(schema), "…nor a session's owner");
check(/userId: uuid\('user_id'\)\.references\(\(\) => users\.id, \{ onDelete: 'set null' \}\)/.test(schema), "A PARTICIPANT OUTLIVES ITS USER: set null");
check(!/export async function deleteUser/.test(read('apps/server/src/users.ts')), 'there is no row delete of a user anywhere the CLI reaches');
const leaving = read('apps/server/src/leaving.ts');
check(/export const FORMER_MEMBER = 'former-member'/.test(leaving) && /deleted-\$\{userId\}@deleted\.invalid/.test(leaving), 'the replacement name is a handle, the sentinel address is in .invalid');
check(/isNull\(users\.deactivatedAt\),\s*isNull\(users\.deletedAt\)/.test(read('apps/server/src/auth.ts')), 'TOKEN RESOLUTION REFUSES a deactivated or deleted account');
check(/isActiveUser\(db, actor\)/.test(read('apps/server/src/agents.ts')) && /isNull\(users\.deactivatedAt\), isNull\(users\.deletedAt\)/.test(read('apps/server/src/devices.ts')), '…and so do agent tokens and devices');
check(/key: 'account', label: 'Account'/.test(read('apps/web/src/pages/SettingsPage.tsx')) && /Delete my account/.test(read('apps/web/src/pages/AccountPage.tsx')), 'Settings → Account → Delete my account');
check(/!p\.account && p\.displayName/.test(read('apps/web/src/mentions.tsx')), 'a person who left is not mentionable');

/* ------------------------------------------------ 2. the server */

const alice = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
check(!!alice, 'the test account signs in');
const aliceMe = (await req('/auth/me', { cookie: alice })).json.user;
const stamp = Date.now();

// Fede: a fresh account through a one-off link from Alice, then the owner of their own organization.
const seed = (await req('/sessions', { method: 'POST', body: { title: `M58 seed ${stamp}`, visibility: 'private' }, cookie: alice })).json;
const seedInv = (await req(`/o/${seed.ownerSlug}/s/${seed.publicId}/invites`, { method: 'POST', body: {}, cookie: alice })).json;
const fedeEmail = `m58-fede-${stamp}@example.com`;
const fedeSignup = await req('/auth/signup', { method: 'POST', body: { token: seedInv.token, email: fedeEmail, password: 'password123', displayName: `Fede${stamp}` } });
check(fedeSignup.status === 201, 'Fede makes an account');
let fede = fedeSignup.cookie;
const fedeId = fedeSignup.json.user.id;

const org = (await req('/teams', { method: 'POST', body: { name: `M58 org ${stamp}` }, cookie: fede })).json;
const orgInv = (await req(`/teams/${org.id}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
check((await req(`/invites/${orgInv.token}/redeem`, { method: 'POST', cookie: alice })).status === 200, "Alice joins Fede's organization");
const shared = (await req('/sessions', { method: 'POST', body: { title: `M58 shared ${stamp}`, teamId: org.id }, cookie: fede })).json;
const base = `/o/${shared.ownerSlug}/s/${shared.publicId}`;
const sharedInv = (await req(`${base}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
check((await req(`/invites/${sharedInv.token}/redeem`, { method: 'POST', cookie: alice })).status === 200, 'Alice is in the shared room');
check((await req(`${base}/messages`, { method: 'POST', body: { content: 'from fede, before leaving' }, cookie: fede })).status === 201, 'Fede writes in it');
check((await req(`${base}/messages`, { method: 'POST', body: { content: 'from alice' }, cookie: alice })).status === 201, 'so does Alice');
const solo = (await req('/sessions', { method: 'POST', body: { title: `M58 solo ${stamp}`, teamId: org.id }, cookie: fede })).json;
check(solo?.publicId, 'and Fede has a room nobody else is in');

// The request: password required, then signed out everywhere.
check((await req('/me/deletion', { method: 'POST', body: { eraseName: false }, cookie: fede })).status === 400, 'DELETION NEEDS THE PASSWORD');
check((await req('/me/deletion', { method: 'POST', body: { password: 'wrong', eraseName: false }, cookie: fede })).status === 401, '…the right one');
const asked = await req('/me/deletion', { method: 'POST', body: { password: 'password123', eraseName: false }, cookie: fede });
check(asked.status === 200 && typeof asked.json.effectiveAt === 'string' && asked.json.graceDays >= 0, 'Fede asks to leave, and is told the date');
check((await req('/auth/me', { cookie: fede })).status === 401, 'SIGNED OUT EVERYWHERE AT ONCE');
check((await req(`${base}/members`, { cookie: alice })).json.find((m) => m.userId === fedeId)?.account === 'deactivated', 'Alice sees Fede marked deactivated in People');

// Signing in cancels.
const back = await req('/auth/login', { method: 'POST', body: { email: fedeEmail, password: 'password123' } });
check(back.status === 200 && /cancelled/i.test(back.json.notice ?? ''), 'SIGNING IN DURING THE GRACE PERIOD CANCELS, and says so');
fede = back.cookie;
check((await req(`${base}/members`, { cookie: alice })).json.find((m) => m.userId === fedeId)?.account === undefined, '…and the mark is gone');
check((await req('/auth/login', { method: 'POST', body: { email: fedeEmail, password: 'password123' } })).json.notice === undefined, 'an ordinary sign-in says nothing');

// Asking again, this time removing the name; then the operator deletes now.
check((await req('/me/deletion', { method: 'POST', body: { password: 'password123', eraseName: true }, cookie: fede })).status === 200, 'Fede asks again: remove my name');
let out = '';
try {
  out = admin('delete-user', '--email', fedeEmail, '--now', '--yes');
} catch (err) {
  out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}
check(/deleted m58-fede/.test(out), `the operator deletes now: ${out.trim().split('\n').pop()}`);
check(new RegExp(`M58 solo ${stamp}`).test(out) && /nobody else is in, deleted/.test(out), 'THE CLI SAID the room nobody else was in goes');
check(new RegExp(`M58 shared ${stamp}`).test(out) && /passed to their oldest remaining member/.test(out), '…and the shared room passes to Alice');

// What Alice sees afterwards. The room passed to her, so its path names her (ADR 0006).
check((await req(base, { cookie: alice })).status === 404, "the room's old path, under Fede's slug, is gone");
const base2 = `/o/${aliceMe.ownerSlug}/s/${shared.publicId}`;
const participants = (await req(`${base2}/participants`, { cookie: alice })).json;
const former = (participants ?? []).find((p) => p.displayName.startsWith('former-member'));
check(former && former.account === 'deleted', "FEDE'S PARTICIPANT STAYS, as former-member, marked deleted");
const messages = (await req(`${base2}/messages`, { cookie: alice })).json;
const list = Array.isArray(messages) ? messages : messages?.messages ?? [];
const fedeMsg = list.find((m) => m.content === 'from fede, before leaving');
check(fedeMsg && (fedeMsg.author?.displayName ?? fedeMsg.authorName ?? '').startsWith('former-member'), "…and their message is there, under that name");
check(!(await req(`${base2}/members`, { cookie: alice })).json.some((m) => m.userId === fedeId), 'they are no longer a member');
check((await req('/sessions', { cookie: alice })).json.find((s) => s.publicId === shared.publicId)?.role === 'owner', 'ALICE OWNS THE SHARED ROOM NOW');
const team = (await req(`/teams/${org.id}`, { cookie: alice })).json;
check(team?.members?.find((m) => m.userId !== fedeId)?.role === 'owner' && !team.members.some((m) => m.userId === fedeId), '…and the organization');
check((await req('/auth/login', { method: 'POST', body: { email: fedeEmail, password: 'password123' } })).status === 401, "FEDE'S SIGN-IN FAILS like a wrong password");
check(/\(deleted\)/.test(admin('list-users')) && !new RegExp(fedeEmail).test(admin('list-users')), 'list-users shows no address for the account');

// Deactivation, reversible, through the CLI.
const gEmail = `m58-gus-${stamp}@example.com`;
const seedInv2 = (await req(`/o/${seed.ownerSlug}/s/${seed.publicId}/invites`, { method: 'POST', body: {}, cookie: alice })).json;
const gus = await req('/auth/signup', { method: 'POST', body: { token: seedInv2.token, email: gEmail, password: 'password123', displayName: `Gus${stamp}` } });
check(gus.status === 201, 'Gus makes an account');
admin('deactivate-user', '--email', gEmail);
check((await req('/auth/me', { cookie: gus.cookie })).status === 401, 'DEACTIVATED: the open session is dead');
check((await req('/auth/login', { method: 'POST', body: { email: gEmail, password: 'password123' } })).status === 401, '…and sign-in is refused like a wrong password');
admin('reactivate-user', '--email', gEmail);
check((await req('/auth/login', { method: 'POST', body: { email: gEmail, password: 'password123' } })).status === 200, 'REACTIVATED: sign-in works, nothing lost');

// Tidy: the seed room and Gus's account.
admin('delete-user', '--email', gEmail, '--now', '--yes');
await req(`/o/${seed.ownerSlug}/s/${seed.publicId}`, { method: 'DELETE', cookie: alice });

console.log(failures ? `\n${failures} FAILED` : '\nM58 checks passed');
process.exit(failures ? 1 : 0);
