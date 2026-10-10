/**
 * M42 acceptance: needs you (ADR 0037).
 *
 * Two accounts on one team. Fede listens on /api/me/stream while Mia writes:
 *   - a message that doesn't mention him: unread, no number, no notification;
 *   - a mention: the number goes up and a notification names who and where;
 *   - marking the room seen clears it;
 *   - a room set to "nothing": no number, no notification, still on Home;
 *   - a direct message notifies without a mention;
 *   - a pause notifies the members who can resume it;
 *   - a room he can't see is never named, even when his name is typed in it.
 * An agent finishing (owned by Fede) needs a real run: the manual test, and
 * FABRIKKA_TEST_SPAWN's m5 check, cover it.
 *
 * Requires: the server on :9090, the test account (_setup.mjs), and Docker's
 * Postgres (fabrikka-postgres) to clean up the second account.
 */
import { execFile } from 'node:child_process';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0] ?? '';
// A JSON content type only with a body, as the web app sends it.
const as = (cookie) => (path, init = {}) =>
  fetch(`${BASE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie, ...(init.headers ?? {}) } });
const json = async (res) => res.json();

const fedeLogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const fedeCookie = cookieOf(fedeLogin);
const fede = as(fedeCookie);
const me = (await json(fedeLogin)).user;

/* ------------------------------------------------ setup: a team with Mia on it */

const stamp = Date.now();
const team = await json(await fede('/teams', { method: 'POST', body: JSON.stringify({ name: `M42 ${stamp}` }) }));
const invite = await json(await fede(`/teams/${team.id}/invites`, { method: 'POST', body: '{}' }));
const miaEmail = `m42-${stamp}@example.com`;
const mia = as(cookieOf(await fetch(`${BASE}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: invite.token, email: miaEmail, displayName: `mia${stamp}`, password: 'm42-member-password' }),
})));
const chat = await json(await fede(`/teams/${team.id}/chats`, { method: 'POST', body: JSON.stringify({ name: `m42-${stamp}` }) }));
const room = (s) => `/o/${s.ownerSlug}/s/${s.publicId}`;
const say = (who, s, content) => who(`${room(s)}/messages`, { method: 'POST', body: JSON.stringify({ content }) });

/* ------------------------------------------------ Fede's stream */

const heard = [];
const unauth = new WebSocket(`${BASE.replace('http', 'ws')}/api/me/stream`);
const refused = await new Promise((ok) => {
  unauth.onmessage = (m) => ok(JSON.parse(m.data));
  setTimeout(() => ok(null), 3000);
});
check(refused?.type === 'stream.error' && refused.code === 'unauthenticated', 'the stream refuses without a login');

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/me/stream`, { headers: { cookie: fedeCookie } });
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = fail;
});
ws.onmessage = (m) => heard.push(JSON.parse(m.data));
const settle = () => sleep(600);
const about = (s) => heard.filter((e) => e.publicId === s.publicId);
const take = () => heard.splice(0);

await fede(`${room(chat)}/seen`, { method: 'POST' });
await settle();
take();

/* ------------------------------------------------ 1. unread is not "needs you" */

await say(mia, chat, 'lunch anyone?');
await settle();
let got = about(chat);
check(got.some((e) => e.type === 'attention' && e.unread && e.needsYou === 0), 'a message without a mention: unread, at once, with no number');
check(!got.some((e) => e.type === 'notify'), '…and no notification');
take();

/* ------------------------------------------------ 2. a mention */

await say(mia, chat, `@${me.displayName} can you check this?\nsecond line`);
await settle();
got = about(chat);
check(got.some((e) => e.type === 'attention' && e.needsYou === 1), 'a mention: the room needs him, live (1)');
const note = got.find((e) => e.type === 'notify');
check(note?.title === `mia${stamp} mentioned you in ${chat.title}` && note.body === `@${me.displayName} can you check this?` && note.path === room(chat), 'a notification says who and where, then the first line, and opens the room');
const listed = (await json(await fede('/sessions'))).find((s) => s.publicId === chat.publicId);
check(listed?.needsYou === 1 && listed.notify === 'needs_you', 'the sidebar list agrees, and the default is what needs me');
take();

await fede(`${room(chat)}/seen`, { method: 'POST' });
await settle();
check(about(chat).some((e) => e.type === 'attention' && e.needsYou === 0 && !e.unread), 'opening the room clears it, on every page he has open');
take();

/* ------------------------------------------------ 3. muted */

check((await fede(`${room(chat)}/notify`, { method: 'PUT', body: JSON.stringify({ notify: 'loud' }) })).status === 400, 'an unknown setting is refused');
check((await json(await fede(`${room(chat)}/notify`, { method: 'PUT', body: JSON.stringify({ notify: 'nothing' }) }))).notify === 'nothing', 'he mutes the room');
take();
await say(mia, chat, `@${me.displayName} still there?`);
await settle();
got = about(chat);
check(!got.some((e) => e.type === 'notify') && got.every((e) => e.type !== 'attention' || (e.needsYou === 0 && !e.unread)), 'A MUTED ROOM: NO NUMBER, NOT BOLD, NO NOTIFICATION');
const waiting = await json(await fede('/waiting'));
check(waiting.some((w) => w.session.publicId === chat.publicId && w.text.includes('still there?')), "…and the mention still waits on Home");
await fede(`${room(chat)}/notify`, { method: 'PUT', body: JSON.stringify({ notify: null }) });
await fede(`${room(chat)}/seen`, { method: 'POST' });
take();

/* ------------------------------------------------ 4. a direct message */

const direct = await json(await mia('/directs', { method: 'POST', body: JSON.stringify({ userId: me.id }) }));
await settle();
take();
await say(mia, direct, 'quick question');
await settle();
got = about(direct);
check(got.some((e) => e.type === 'notify' && e.title === `mia${stamp}` && e.body === 'quick question'), 'a direct message notifies without a mention');
check((await json(await fede('/sessions'))).find((s) => s.publicId === direct.publicId)?.notify === 'everything', 'direct chats default to everything');
take();

/* ------------------------------------------------ 5. a pause */

await mia(`${room(chat)}/pause`, { method: 'POST' });
await settle();
check(about(chat).some((e) => e.type === 'notify' && e.title === `${chat.title} is paused`), 'a paused room notifies the members who can resume it');
await mia(`${room(chat)}/pause`, { method: 'DELETE' });
take();

/* ------------------------------------------------ 6. a room he can't see */

const secret = await json(await mia('/sessions', { method: 'POST', body: JSON.stringify({ title: `mia only ${stamp}` }) }));
await say(mia, secret, `@${me.displayName} you can't see this`);
await settle();
check(about(secret).length === 0 && !JSON.stringify(heard).includes(secret.publicId), "A ROOM HE CAN'T SEE IS NEVER NAMED ON HIS STREAM");

/* ------------------------------------------------ 7. the desktop app's two commands */

const rust = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
check(/\.permission\("allow-notify"\)/.test(rust) && /\.permission\("allow-set-attention"\)/.test(rust), 'the instance may call notify and set_attention in the app, and nothing new beyond them');
check(/fn instance_path/.test(rust) && /NOTE_PER_MINUTE: usize = 30/.test(rust), "the app accepts only paths on the instance, and caps the rate (cargo test checks both)");

ws.close();
// Leave nothing behind: Mia, her rooms and the team (Docker's Postgres, as m32 and m43 do).
const psql = (q) => new Promise((ok) => execFile('docker', ['exec', '-i', 'fabrikka-postgres', 'psql', '-U', 'fabrikka', '-d', 'fabrikka', '-tAc', q], () => ok()));
await psql(`delete from teams where id = '${team.id}'`);
await psql(`delete from sessions where owner_id = (select id from users where email = '${miaEmail}')`);
await psql(`delete from users where email = '${miaEmail}'`);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM42 checks passed');
process.exit(0);
