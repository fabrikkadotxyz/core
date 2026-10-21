/**
 * M66 acceptance: files in a bucket (ADR 0060).
 *
 * Always: from the source, downloads stay behind the room's check and nothing
 * presigns a URL; a core told to use a bucket that does not answer, or a
 * store that does not exist, refuses to start and says why.
 *
 * With FABRIKKA_TEST_S3=1 (needs Docker): starts an S3-compatible server
 * (Versity Gateway, a folder served as S3) in a container, spawns a core with
 * FABRIKKA_FILES=s3, uploads a file to a room and downloads the same bytes,
 * finds the object at its content key in the bucket and not on disk, copies a
 * disk tree across with `admin files copy`, reads `admin files status`, and
 * stops a core whose secret is wrong. With FABRIKKA_TEST_BACKUP=1 as well, it
 * backs up from the bucket and restores into a second prefix.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) for the test
 * account, and free ports M66_PORT (default 9466) and M66_S3_PORT (9766).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.M66_PORT ?? 9466);
const S3_PORT = Number(process.env.M66_S3_PORT ?? 9766);
const BUCKETED = `http://localhost:${PORT}`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const CONTAINER = 'fabrikka-m66-s3';
let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const read = (p) => readFileSync(p, 'utf8');
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const keyOf = (h) => `${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;

/** Start a core with this environment; resolve with whether it served, and what it said. */
async function core(env, { expectExit = false } = {}) {
  const child = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', 'src/index.ts'], {
    cwd: 'apps/server',
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: BUCKETED, FABRIKKA_BACKUP_DIR: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let exited = null;
  child.on('exit', (code) => (exited = code));
  for (let i = 0; i < 120; i++) {
    if (exited !== null) break;
    if (!expectExit && (await fetch(`${BUCKETED}/health`).catch(() => null))?.ok) break;
    await settle(500);
  }
  return { child, exited, output: () => out };
}

/* ------------------------------------------------ 1. the source */

const app = read('apps/server/src/app.ts');
const src = ['apps/server/src/app.ts', 'apps/server/src/artifacts.ts', 'apps/server/src/file-store.ts', 'apps/server/src/s3.ts', 'apps/server/src/mcp.ts'].map(read).join('\n');
check(/sessionRoutes\.get\('\/artifacts\/:id\/content', async \(c\) => \{[\s\S]{0,200}const s = await resolveViewer\(c\);\s*if \(!s\) return c\.notFound\(\);\s*const found = await readArtifact\(db, s\.id/.test(app), 'DOWNLOADS STAY BEHIND THE ROOM: the server reads the bytes, after the membership check');
check(!/X-Amz-Signature|presign|X-Amz-Expires/i.test(src), 'NOTHING PRESIGNS A URL: no link to the bucket ever leaves the server');
check(/await files\(\)\.put\(blobKey\(hash\), opts\.content\)/.test(read('apps/server/src/artifacts.ts')) && /await files\(\)\.get\(blobKey\(row\.a\.storageKey\)\)/.test(read('apps/server/src/artifacts.ts')), 'uploads and reads go through the configured store, by content key');
check(!/delete|DELETE/.test(read('apps/server/src/file-store.ts').replace(/never deletes|never deleted/g, '')), 'the store has no delete: write once, never removed by Fabrikka');
check(/await files\(\)\.check\(\);[\s\S]{0,400}process\.exit\(1\);[\s\S]{0,200}await runMigrations\(db\)/.test(app), 'the store is checked before anything else at start');

/* ------------------------------------------------ 2. a store that does not answer */

{
  const down = await core({ FABRIKKA_FILES: 's3', FABRIKKA_S3_ENDPOINT: 'http://127.0.0.1:9', FABRIKKA_S3_BUCKET: 'fabrikka', FABRIKKA_S3_ACCESS_KEY_ID: 'm66-access', FABRIKKA_S3_SECRET_ACCESS_KEY: 'm66-never-printed' }, { expectExit: true });
  check(down.exited === 1, 'A BUCKET THAT DOES NOT ANSWER STOPS THE SERVER');
  check(/\[files\] s3 bucket "fabrikka" at 127\.0\.0\.1:9 does not answer: could not reach/.test(down.output()) && /refusing to start/.test(down.output()), '…saying which store and why');
  check(!down.output().includes('m66-never-printed'), '…without the secret');
  down.child.kill();
  const incomplete = await core({ FABRIKKA_FILES: 's3', FABRIKKA_S3_BUCKET: '', FABRIKKA_S3_ACCESS_KEY_ID: '', FABRIKKA_S3_SECRET_ACCESS_KEY: '' }, { expectExit: true });
  check(incomplete.exited === 1 && /FABRIKKA_FILES=s3 needs FABRIKKA_S3_BUCKET, FABRIKKA_S3_ACCESS_KEY_ID, FABRIKKA_S3_SECRET_ACCESS_KEY/.test(incomplete.output()), 'settings left out are named');
  incomplete.child.kill();
  const typo = await core({ FABRIKKA_FILES: 'ftp' }, { expectExit: true });
  check(typo.exited === 1 && /FABRIKKA_FILES must be "disk" or "s3", not "ftp"/.test(typo.output()), 'a store that does not exist is refused');
  typo.child.kill();
}

/* ------------------------------------------------ 3. a real bucket */

if (process.env.FABRIKKA_TEST_S3 !== '1') {
  console.log('skipped the bucket: set FABRIKKA_TEST_S3=1 to run an S3-compatible server in Docker');
} else {
  const S3 = {
    FABRIKKA_FILES: 's3',
    FABRIKKA_S3_ENDPOINT: `http://localhost:${S3_PORT}`,
    FABRIKKA_S3_BUCKET: 'fabrikka',
    FABRIKKA_S3_ACCESS_KEY_ID: 'fabrikka',
    FABRIKKA_S3_SECRET_ACCESS_KEY: `m66-${Date.now()}`,
    FABRIKKA_S3_PREFIX: 'm66/',
  };
  const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const inBucket = (key, prefix = 'm66/') => {
    try {
      docker('exec', CONTAINER, 'test', '-f', `/data/fabrikka/${prefix}${key}`);
      return true;
    } catch {
      return false;
    }
  };
  const admin = (env, ...args) => execFileSync('pnpm', ['--silent', 'admin', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  try { docker('rm', '-f', CONTAINER); } catch { /* not there */ }
  docker('run', '-d', '--name', CONTAINER, '-p', `${S3_PORT}:7070`, '--entrypoint', 'sh', 'versity/versitygw:latest', '-c',
    `mkdir -p /data/fabrikka && exec versitygw --access fabrikka --secret ${S3.FABRIKKA_S3_SECRET_ACCESS_KEY} posix /data`);
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://localhost:${S3_PORT}/`).catch(() => null)) break;
    await settle(250);
  }
  const diskDir = mkdtempSync(join(tmpdir(), 'm66-disk-'));
  const server = await core({ ...S3, ARTIFACT_DIR: diskDir });
  try {
    check(server.exited === null && /\[files\] s3 bucket "fabrikka" at localhost:\d+, prefix "m66\/"/.test(server.output()), 'A CORE ON A BUCKET STARTS, and its first line names the bucket');
    const login = await fetch(`${BUCKETED}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0];
    const headers = { cookie, connection: 'close' };
    const room = await (await fetch(`${BUCKETED}/api/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ title: `M66 ${Date.now()}`, visibility: 'private' }) })).json();
    const base = `${BUCKETED}/api/o/${room.ownerSlug}/s/${room.publicId}`;
    const bytes = Buffer.from(`M66 says hello at ${new Date().toISOString()}\n`);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/plain' }), 'hello.txt');
    const up = await fetch(`${base}/artifacts`, { method: 'POST', body: form, headers });
    const art = await up.json();
    check(up.status === 201, 'a file uploads to a room');
    const key = keyOf(sha(bytes));
    check(inBucket(key), `THE OBJECT IS IN THE BUCKET at its content key, ${key.slice(0, 12)}…`);
    check(!existsSync(join(diskDir, ...key.split('/'))), '…and not on disk');
    const down = await fetch(`${base}/artifacts/${art.id}/content`, { headers });
    check(down.status === 200 && Buffer.from(await down.arrayBuffer()).equals(bytes), 'THE DOWNLOAD IS THE SAME BYTES');
    const stranger = await fetch(`${base}/artifacts/${art.id}/content`, { headers: { connection: 'close' } });
    check([401, 404].includes(stranger.status) && !Buffer.from(await stranger.arrayBuffer()).includes(bytes), 'and someone signed out gets nothing');

    // A disk tree, as an instance that started on disk has, copied across.
    const old = Buffer.from(`uploaded before the bucket ${Date.now()}`);
    const oldKey = keyOf(sha(old));
    mkdirSync(join(diskDir, oldKey.split('/')[0], oldKey.split('/')[1]), { recursive: true });
    writeFileSync(join(diskDir, ...oldKey.split('/')), old);
    const copied = admin({ ...S3, ARTIFACT_DIR: diskDir }, 'files', 'copy', '--to', 's3');
    check(/1 copied, 0 already there/.test(copied) && inBucket(oldKey), 'ADMIN FILES COPY MOVES A DISK TREE INTO THE BUCKET');
    check(/0 copied, 1 already there/.test(admin({ ...S3, ARTIFACT_DIR: diskDir }, 'files', 'copy', '--to', 's3')), '…and a second run copies nothing');
    const back = mkdtempSync(join(tmpdir(), 'm66-back-'));
    admin({ ...S3, ARTIFACT_DIR: back }, 'files', 'copy', '--to', 'disk');
    check(existsSync(join(back, ...key.split('/'))) && existsSync(join(back, ...oldKey.split('/'))), '…and --to disk brings it all back');
    rmSync(back, { recursive: true, force: true });
    let status = '';
    try {
      status = admin(S3, 'files', 'status');
    } catch (err) {
      status = `${err.stdout ?? ''}`; // exit 2 when files are missing, which other rooms' files on the dev instance may be
    }
    check(/^FABRIKKA_FILES=s3: s3 bucket "fabrikka"/m.test(status) && /distinct file\(s\) referenced, \d+ missing from this store/.test(status), 'admin files status names the store and counts what is missing');

    if (process.env.FABRIKKA_TEST_BACKUP === '1') {
      const dir = mkdtempSync(join(tmpdir(), 'm66-backup-'));
      const KEY = `m66-${Date.now()}`;
      const out = admin({ ...S3, FABRIKKA_BACKUP_KEY: KEY }, 'backup', '--to', dir);
      const manifest = JSON.parse(out.match(/^manifest (.+)$/m)?.[1] ?? 'null');
      check(manifest?.artifacts.count >= 2, `THE BACKUP READS THE BUCKET: ${manifest?.artifacts.count} file(s)`);
      const DATABASE_URL = process.env.DATABASE_URL ?? read('.env').match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
      const adminUrl = new URL(DATABASE_URL);
      adminUrl.pathname = '/postgres';
      const scratchDb = `fabrikka_m66_${Date.now()}`;
      execFileSync('psql', [adminUrl.href, '-tAc', `create database ${scratchDb}`]);
      const scratchUrl = new URL(DATABASE_URL);
      scratchUrl.pathname = `/${scratchDb}`;
      try {
        const restored = admin({ ...S3, FABRIKKA_S3_PREFIX: 'm66-restored/', FABRIKKA_BACKUP_KEY: KEY, DATABASE_URL: scratchUrl.href }, 'restore', '--file', out.match(/^wrote (.+)$/m)[1]);
        check(/restored: .* into s3 bucket "fabrikka"/.test(restored) && inBucket(key, 'm66-restored/') && inBucket(oldKey, 'm66-restored/'), 'A RESTORE WRITES INTO THE BUCKET');
      } finally {
        execFileSync('psql', [adminUrl.href, '-tAc', `drop database if exists ${scratchDb} with (force)`]);
        rmSync(dir, { recursive: true, force: true });
      }
    }
    await fetch(base, { method: 'DELETE', headers });
  } finally {
    server.child.kill();
    await settle(500);
  }

  const wrong = await core({ ...S3, FABRIKKA_S3_SECRET_ACCESS_KEY: 'not-the-secret' }, { expectExit: true });
  check(wrong.exited === 1 && /The bucket rejected the key/.test(wrong.output()), 'A WRONG SECRET STOPS THE SERVER, and says the bucket rejected the key');
  wrong.child.kill();
  try { docker('rm', '-f', CONTAINER); } catch { /* gone */ }
  rmSync(diskDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nM66 checks passed');
process.exit(failures ? 1 : 0);
