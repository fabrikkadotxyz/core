/**
 * M56 acceptance: the home — what needs you, what is running, what changed.
 *
 * Against the server, as two accounts: a mention lands under needsYou until
 * the room is opened; a message without a mention counts under changed; a
 * mention of a person by you lists under waitingOnOthers until they answer;
 * a one-off link you sent lists under openInvites until revoked; computers is
 * the device list with agent counts. Runs need a real agent run, so running
 * and finished are checked by shape. From the source: the sections and that
 * each item links to its room.
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

const home = read('apps/web/src/pages/HomePage.tsx');
for (const label of ['Needs you', 'Running now', 'Finished while you were away', 'Since you were away', 'Waiting on others', 'One-off sessions, open', 'Your computers']) {
  check(new RegExp(`(title|label)="${label}"`).test(home), `the home has ${label}`);
}
check(!/Create organization/.test(home) && !/Pick up where you left off/i.test(home), 'no organization form, no "pick up where you left off"');
check(/sessions\.home\(\)/.test(home) && /window\.addEventListener\('focus', load\)/.test(home), 'one call for the whole home; refreshed when the tab comes back');
check(/export async function homeFor\(/.test(read('apps/server/src/home.ts')) && /app\.get\('\/api\/me\/home'/.test(read('apps/server/src/app.ts')), 'one read-only endpoint, GET /api/me/home');

/* ------------------------------------------------ 2. the server */

const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const S = (await req('/sessions', { method: 'POST', body: { title: `Home ${stamp}` }, cookie: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const inv = (await req(`${base}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
let h = (await req('/me/home', { cookie: fede })).json;
check(h && ['needsYou', 'running', 'finished', 'changed', 'waitingOnOthers', 'openInvites', 'computers'].every((k) => Array.isArray(h[k])), 'THE HOME IS ONE ANSWER with seven lists');
check(h.openInvites.some((i) => i.id === inv.invite.id && i.session.publicId === S.publicId && i.expiresAt > i.createdAt), 'A ONE-OFF LINK YOU SENT IS LISTED AS OPEN, with its room and when it expires');
check(Array.isArray(h.computers) && h.computers.every((d) => typeof d.online === 'boolean' && typeof d.agents === 'number'), 'your computers, each online or not, with how many agents it runs');

const pat = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m56-pat-${stamp}@example.com`, password: 'password123', displayName: `Pat${stamp}` } });
check(pat.status === 201, 'Pat joins through the link');
h = (await req('/me/home', { cookie: fede })).json;
check(!h.openInvites.some((i) => i.id === inv.invite.id), '…and the link is no longer open');

// Fede asks Pat something: waiting on others, until Pat answers.
const patName = `Pat${stamp}`;
await req(`${base}/messages`, { method: 'POST', body: { content: `@${patName} can you check this?` }, cookie: fede });
h = (await req('/me/home', { cookie: fede })).json;
check(h.waitingOnOthers.some((w) => w.session.publicId === S.publicId && w.to.includes(patName)), 'WAITING ON OTHERS: the last word is yours and names Pat');
// Pat sees the mention under needs you, and the room under changed.
let hp = (await req('/me/home', { cookie: pat.cookie })).json;
check(hp.needsYou.some((n) => n.session.publicId === S.publicId), "NEEDS YOU: Pat's home lists the mention");
check(hp.changed.some((c) => c.session.publicId === S.publicId && c.messages >= 1), '…and the room under since you were away');
await req(`${base}/seen`, { method: 'POST', body: {}, cookie: pat.cookie });
hp = (await req('/me/home', { cookie: pat.cookie })).json;
check(!hp.needsYou.some((n) => n.session.publicId === S.publicId) && !hp.changed.some((c) => c.session.publicId === S.publicId), 'opening the room clears both for Pat');
await req(`${base}/messages`, { method: 'POST', body: { content: 'done, looks fine' }, cookie: pat.cookie });
h = (await req('/me/home', { cookie: fede })).json;
check(!h.waitingOnOthers.some((w) => w.session.publicId === S.publicId), 'Pat answers: Fede is no longer waiting on them');
check(h.changed.some((c) => c.session.publicId === S.publicId && c.messages === 1), "…and Pat's answer counts under since you were away for Fede");

// Revoke an open link from the home.
const S2 = (await req('/sessions', { method: 'POST', body: { title: `Home 2 ${stamp}` }, cookie: fede })).json;
const inv2 = (await req(`/o/${S2.ownerSlug}/s/${S2.publicId}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
await req(`/o/${S2.ownerSlug}/s/${S2.publicId}/invites/${inv2.invite.id}/revoke`, { method: 'POST', body: {}, cookie: fede });
h = (await req('/me/home', { cookie: fede })).json;
check(!h.openInvites.some((i) => i.id === inv2.invite.id) && (await req(`/invites/${inv2.token}`)).status === 404, 'REVOKE: the link leaves the home and stops working');

console.log(failures ? `\n${failures} FAILED` : '\nM56 checks passed');
process.exit(failures ? 1 : 0);
