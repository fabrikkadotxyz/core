/**
 * M62 acceptance: download my data.
 *
 * Against the server: a fresh account is in two rooms and writes in both; a
 * third room it is not in holds a message too. The export refuses without
 * and with the wrong password; with the right one it is a zip of thirteen
 * files; messages.json has the account's messages from both rooms and nothing
 * from the third or by anyone else; connections.json has no sealed field; the
 * trail has the event. The zip is read here with a few lines of the format,
 * as zip.ts writes it: deflated entries, a central directory.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) and the test account.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

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
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  return { status: r.status, json, buf, cookie: set ? set.split(';')[0] : undefined, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '' };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

/** The entries of a zip as zip.ts writes it: name → inflated text. */
function unzip(buf) {
  const files = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const packedLen = buf.readUInt32LE(p + 20);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    files[name] = inflateRawSync(buf.subarray(start, start + packedLen)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ------------------------------------------------ 1. the source */

const src = read('apps/server/src/account-export.ts');
check(
  !/sealedCredential|sealedRefreshToken|headers: mcpServers\.headers/.test(src) && (src.match(/passwordHash/g) ?? []).length === 1 && /verifyPassword\(password, u\.passwordHash\)/.test(src),
  'THE EXPORT NEVER READS A TOKEN OR A HEADER, and touches the password hash only to verify',
);
check(/inArray\(messages\.authorParticipantId, participantIds\)/.test(src), "messages are the person's own, by their participants");
check(/exportAccount\(db, me\.id, body\.password\)/.test(read('apps/server/src/app.ts')) && /action: 'account\.exported'/.test(read('apps/server/src/app.ts')), 'behind the password, and in the trail');
check(/Download my data/.test(read('apps/web/src/pages/AccountPage.tsx')), 'Settings → Account → Download my data');

/* ------------------------------------------------ 2. the server */

const alice = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const shared = (await req('/sessions', { method: 'POST', body: { title: `M62 shared ${stamp}`, visibility: 'private' }, cookie: alice })).json;
const inv = (await req(`/o/${shared.ownerSlug}/s/${shared.publicId}/invites`, { method: 'POST', body: {}, cookie: alice })).json;
const patEmail = `m62-pat-${stamp}@example.com`;
const pat = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: patEmail, password: 'password123', displayName: `Pat${stamp}` } });
check(pat.status === 201, 'Pat makes an account through a link into the shared room');
const sharedBase = `/o/${shared.ownerSlug}/s/${shared.publicId}`;
await req(`${sharedBase}/messages`, { method: 'POST', body: { content: `PAT-SHARED-${stamp}` }, cookie: pat.cookie });
await req(`${sharedBase}/messages`, { method: 'POST', body: { content: `ALICE-SHARED-${stamp}` }, cookie: alice });
const own = (await req('/sessions', { method: 'POST', body: { title: `M62 own ${stamp}`, visibility: 'private' }, cookie: pat.cookie })).json;
await req(`/o/${own.ownerSlug}/s/${own.publicId}/messages`, { method: 'POST', body: { content: `PAT-OWN-${stamp}` }, cookie: pat.cookie });
const other = (await req('/sessions', { method: 'POST', body: { title: `M62 other ${stamp}`, visibility: 'private' }, cookie: alice })).json;
await req(`/o/${other.ownerSlug}/s/${other.publicId}/messages`, { method: 'POST', body: { content: `ALICE-OTHER-${stamp}` }, cookie: alice });

check((await req('/me/export', { method: 'POST', body: {}, cookie: pat.cookie })).status === 400, 'THE EXPORT NEEDS THE PASSWORD');
check((await req('/me/export', { method: 'POST', body: { password: 'wrong' }, cookie: pat.cookie })).status === 401, '…the right one');
const got = await req('/me/export', { method: 'POST', body: { password: 'password123' }, cookie: pat.cookie });
check(got.status === 200 && got.type === 'application/zip' && /filename="fabrikka-.*\.zip"/.test(got.disposition), 'with it: one zip, named for the account');
const files = unzip(got.buf);
const names = Object.keys(files).sort();
check(names.length === 13 && names.includes('README.md') && names.includes('messages.json') && names.includes('connections.json') && names.includes('activity.json'), `THIRTEEN FILES: ${names.join(', ')}`);
const messages = JSON.parse(files['messages.json']);
check(messages.some((m) => m.content === `PAT-SHARED-${stamp}` && m.room === shared.publicId) && messages.some((m) => m.content === `PAT-OWN-${stamp}` && m.room === own.publicId), "PAT'S MESSAGES FROM BOTH ROOMS, with the room");
check(!messages.some((m) => m.content.includes('ALICE-')), "…and nobody else's, not even in the shared room");
check(!JSON.stringify(files).includes(`ALICE-OTHER-${stamp}`), '…and nothing from a room Pat is not in');
const profile = JSON.parse(files['profile.json']);
check(profile.email === patEmail && profile.displayName === `Pat${stamp}` && !('passwordHash' in profile), 'the profile, without the hash');
const rooms = JSON.parse(files['rooms.json']);
check(rooms.some((r) => r.publicId === shared.publicId && r.role === 'member') && rooms.some((r) => r.publicId === own.publicId && r.role === 'owner'), 'rooms.json: both rooms with the right role');
check(!/sealed|refresh|headers/.test(files['connections.json']), 'connections.json has no sealed field');
check(/Exported .* for m62-pat/.test(files['README.md']) && /What is not here/.test(files['README.md']), 'the README says what is and is not there');
await settle();
const mine = (await req('/me/audit', { cookie: pat.cookie })).json.events;
check(mine.some((e) => e.action === 'account.exported' && e.outcome === 'ok') && mine.some((e) => e.action === 'account.exported' && e.outcome === 'refused'), 'THE TRAIL has the export and the refused attempt');
check(JSON.parse(files['activity.json']).some((e) => e.action === 'invite.redeemed'), "activity.json carries the person's events");

// Tidy.
execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', patEmail, '--now', '--yes'], { stdio: 'ignore' });
await req(sharedBase, { method: 'DELETE', cookie: alice });
await req(`/o/${other.ownerSlug}/s/${other.publicId}`, { method: 'DELETE', cookie: alice });

console.log(failures ? `\n${failures} FAILED` : '\nM62 checks passed');
process.exit(failures ? 1 : 0);
