/**
 * M67 acceptance: a face for everyone (ADR 0061).
 *
 * The initials and colour rules (the web app's unit test); then, on the
 * running core with its disk store: Pat joins a room by link and sets a PNG;
 * it is on /auth/me, in the room's participants and members (as the owner
 * sees them) and in Pat's organization, and is served with its headers;
 * signed out it is not; an SVG, a renamed text file and a file over 512 KB are
 * refused; a replaced picture's blob is gone; the export holds it; removing
 * it clears avatarUrl and the blob; deleting the account removes it; the
 * trail has the events; agents carry no picture.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) on its disk store
 * (ARTIFACT_DIR, default .artifacts/), and the test account.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const CORE = process.env.FABRIKKA_CORE ?? 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const DIR = process.env.ARTIFACT_DIR ?? '.artifacts';
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
  return { status: r.status, json, cookie: set ? set.split(';')[0] : undefined, headers: r.headers };
}
async function upload(bytes, cookie, { type = 'image/png', name = 'me.png' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(`${CORE}/api/me/avatar`, { method: 'POST', body: form, headers: { cookie, connection: 'close' } });
  return { status: r.status, json: await r.json().catch(() => null) };
}
/** One entry of the export's zip (deflated, no zip64: apps/server/src/zip.ts). */
function unzip(zipBuf, name) {
  for (let i = 0; i + 30 <= zipBuf.length; ) {
    if (zipBuf.readUInt32LE(i) !== 0x04034b50) break;
    const size = zipBuf.readUInt32LE(i + 18);
    const nameLen = zipBuf.readUInt16LE(i + 26);
    const extra = zipBuf.readUInt16LE(i + 28);
    const entry = zipBuf.subarray(i + 30, i + 30 + nameLen).toString();
    const start = i + 30 + nameLen + extra;
    if (entry === name) return inflateRawSync(zipBuf.subarray(start, start + size));
    i = start + size;
  }
  return null;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const blob = (hash) => join(DIR, 'avatars', hash.slice(0, 2), hash.slice(2, 4), hash);
const hashOf = (url) => url?.split('/').pop();

/* ------------------------------------------------ 1. the rules and the source */

try {
  execFileSync('npx', ['tsx', 'src/__tests__/face.test.mts'], { cwd: 'apps/web', stdio: 'pipe' });
  check(true, 'THE INITIALS AND COLOUR RULES PASS (DL, AL, ME, CL; eight colours, stable)');
} catch (err) {
  console.error(String(err.stdout ?? ''));
  check(false, 'the initials and colour rules');
}
const sessionsSrc = read('apps/server/src/sessions.ts');
check(/avatarUrl: p\.kind === 'human' \? avatarUrl\(p\.avatarKey\) : null/.test(sessionsSrc), 'AGENTS NEVER CARRY A PICTURE, whoever registered them');
check(/const MessageRow = memo\(function MessageRow[\s\S]{0,600}<Face name=\{a\.displayName\} seed=\{person\?\.userId \?\? a\.participantId\}/.test(read('apps/web/src/pages/SessionPage.tsx')) && !/'🤖' : '👤'/.test(read('apps/web/src/pages/SessionPage.tsx')), 'a message shows a face, not 👤 or 🤖');
const pic = read('apps/web/src/picture.ts');
check(/PICTURE_SIZE = 256/.test(pic) && /imageOrientation: 'from-image'/.test(pic) && /canvas\.toBlob/.test(pic), 'the browser crops to 256 × 256 and re-encodes, dropping what a camera wrote');
check(/Choose a picture/.test(read('apps/web/src/pages/AccountPage.tsx')), 'Settings → Account offers Choose a picture');

/* ------------------------------------------------ 2. the real thing */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.concat([PNG, Buffer.from(`m67-${Date.now()}`)]); // a different picture, still a PNG by its first bytes

const owner = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const room = (await req('/sessions', { method: 'POST', body: { title: `M67 ${stamp}`, visibility: 'private' }, cookie: owner })).json;
const base = `/o/${room.ownerSlug}/s/${room.publicId}`;
const inv = (await req(`${base}/invites`, { method: 'POST', body: {}, cookie: owner })).json;
const patEmail = `m67-pat-${stamp}@example.com`;
const pat = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: patEmail, password: 'password123', displayName: 'Pat Okafor' } });
const cookie = pat.cookie;
check(pat.status === 201 && (await req('/auth/me', { cookie })).json.user.avatarUrl === null, 'Pat joins by link, with no picture: avatarUrl is null');

try {
  check((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), cookie, { type: 'image/svg+xml', name: 'me.svg' })).status === 400, 'AN SVG IS REFUSED');
  check((await upload(Buffer.from('just text, named like a picture'), cookie, { type: 'image/png', name: 'me.png' })).status === 400, 'a text file named .png is refused: the bytes decide');
  check((await upload(Buffer.concat([PNG, Buffer.alloc(513 * 1024)]), cookie)).status === 413, 'a picture over 512 KB is refused');

  const first = await upload(PNG, cookie);
  const h1 = hashOf(first.json?.avatarUrl);
  check(first.status === 200 && h1 === sha(PNG), `A PNG IS SET, at its content address /api/avatars/${h1?.slice(0, 12)}…`);
  check(existsSync(blob(h1)), '…stored in the file store under avatars/');
  check((await req('/auth/me', { cookie })).json.user.avatarUrl === first.json.avatarUrl, 'it is on /auth/me');

  const view = (await req(base, { cookie: owner })).json;
  const asParticipant = view.participants.find((p) => p.displayName === 'Pat Okafor');
  const asMember = view.members.find((m) => m.email === patEmail);
  check(asParticipant?.avatarUrl === first.json.avatarUrl && asParticipant.userId === asMember?.userId, "THE OWNER SEES IT on Pat's participant, with the account id the colour comes from");
  check(asMember?.avatarUrl === first.json.avatarUrl, "…and on Pat's member row");
  check(view.participants.filter((p) => p.kind === 'agent').every((p) => !p.avatarUrl && p.userId === null), 'agents in the room have none');
  const myTeams = (await req('/teams', { cookie })).json;
  const teamId = (Array.isArray(myTeams) ? myTeams : myTeams?.teams ?? [])[0]?.id;
  const team = teamId ? (await req(`/teams/${teamId}`, { cookie })).json : null;
  check(team?.members?.some((m) => m.avatarUrl === first.json.avatarUrl), "and in Pat's organization's members");

  const served = await fetch(`${CORE}${first.json.avatarUrl}`, { headers: { cookie: owner, connection: 'close' } });
  const bytes = Buffer.from(await served.arrayBuffer());
  check(served.status === 200 && bytes.equals(PNG) && served.headers.get('content-type') === 'image/png', 'IT IS SERVED, the same bytes, as image/png');
  check(served.headers.get('content-security-policy') === "default-src 'none'" && served.headers.get('x-content-type-options') === 'nosniff' && /immutable/.test(served.headers.get('cache-control') ?? ''), "…with default-src 'none', nosniff and immutable caching");
  check((await fetch(`${CORE}${first.json.avatarUrl}`, { headers: { connection: 'close' } })).status === 401, 'SIGNED OUT, there is no picture');
  check((await req(`/avatars/${'0'.repeat(64)}`, { cookie })).status === 404, 'an address no account holds is not found');

  const second = await upload(PNG2, cookie);
  const h2 = hashOf(second.json?.avatarUrl);
  check(h2 && h2 !== h1 && existsSync(blob(h2)) && !existsSync(blob(h1)), 'A REPLACED PICTURE IS DELETED from the store');
  check((await req(`/avatars/${h1}`, { cookie })).status === 404, '…and its old address answers nothing');

  const exported = await fetch(`${CORE}/api/me/export`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, connection: 'close' }, body: JSON.stringify({ password: 'password123' }) });
  const zipped = Buffer.from(await exported.arrayBuffer());
  check(exported.status === 200 && unzip(zipped, 'picture.png')?.equals(PNG2), 'DOWNLOAD MY DATA HOLDS THE PICTURE, byte for byte');
  check(JSON.parse(unzip(zipped, 'profile.json')?.toString() ?? '{}').hasPicture === true, '…and profile.json says there is one');

  const removed = await req('/me/avatar', { method: 'DELETE', cookie });
  check(removed.status === 200 && removed.json.avatarUrl === null && (await req('/auth/me', { cookie })).json.user.avatarUrl === null, 'REMOVE GOES BACK TO INITIALS');
  check(!existsSync(blob(h2)), '…and deletes the blob');
  const trail = (await req('/me/audit', { cookie })).json.events.map((e) => e.action);
  check(trail.includes('profile.picture_changed') && trail.includes('profile.picture_removed'), 'the trail has profile.picture_changed and profile.picture_removed');

  const third = await upload(PNG2, cookie);
  const h3 = hashOf(third.json?.avatarUrl);
  execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', patEmail, '--now', '--yes'], { stdio: 'ignore' });
  check(h3 && !existsSync(blob(h3)), 'DELETING THE ACCOUNT DELETES THE PICTURE');
  check((await req(`/avatars/${h3}`, { cookie: owner })).status === 404, '…and nobody can load it');
} finally {
  await req(base, { method: 'DELETE', cookie: owner });
  try { execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', patEmail, '--now', '--yes'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nM67 checks passed');
process.exit(failures ? 1 : 0);
