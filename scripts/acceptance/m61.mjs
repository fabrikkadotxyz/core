/**
 * M61 acceptance: backups that restore.
 *
 * With the real commands: back up the database this checkout points at and
 * its artifact files into a scratch directory; check the archive's header and
 * the listing; assert a wrong passphrase is refused; restore into a scratch
 * database made for the purpose; compare row counts and the restored file
 * count against the manifest; assert a second restore without --force is
 * refused; drop the scratch database. From the source: the image installs
 * pg_dump 17, the entrypoint seals by default, the docs hold the drill.
 *
 * Gated: FABRIKKA_TEST_BACKUP=1. Needs pg_dump, pg_restore, psql and tar at
 * least the server's major version, and DATABASE_URL (.env). No HTTP server.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.FABRIKKA_TEST_BACKUP !== '1') {
  console.log('skipped: set FABRIKKA_TEST_BACKUP=1 to back up and restore into a scratch database (needs pg_dump, pg_restore, psql)');
  process.exit(0);
}

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const read = (p) => readFileSync(p, 'utf8');

// DATABASE_URL from the environment, else from .env, as the CLI reads it.
const envFile = existsSync('.env') ? read('.env') : '';
const DATABASE_URL = process.env.DATABASE_URL ?? envFile.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set and .env has none');
  process.exit(1);
}
const url = new URL(DATABASE_URL);
const adminUrl = new URL(DATABASE_URL);
adminUrl.pathname = '/postgres';
const psql = (dbUrl, q) => execFileSync('psql', [dbUrl, '-tAc', q], { encoding: 'utf8' }).trim();
const admin = (env, ...args) => execFileSync('pnpm', ['--silent', 'admin', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const adminFails = (env, ...args) => {
  try {
    admin(env, ...args);
    return null;
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
};

/* ------------------------------------------------ 1. the source */

check(/postgresql-client-17/.test(read('docker/Dockerfile')), 'THE IMAGE HAS pg_dump AND pg_restore 17');
const entry = read('docker/entrypoint.sh');
check(/FABRIKKA_BACKUP_DIR="\$data\/backups"/.test(entry) && /backup\.key/.test(entry), 'the entrypoint backs up by default, sealed with a generated passphrase');
check(/createBackup\(\{ databaseUrl: process\.env\.DATABASE_URL!, artifactDir: STORAGE_DIR, passphrase: backupKey, dir: backupDir/.test(read('apps/server/src/app.ts')), 'the server writes one a day');
check(/The restore drill/.test(read('docs/operations.md')) && /Recovery point: 24 hours/.test(read('docs/operations.md')), 'the docs state the targets and the drill');
const bk = read('apps/server/src/backup.ts');
check(/createCipheriv\('aes-256-gcm'/.test(bk) && /scryptSync\(passphrase, salt, 32/.test(bk) && /if \(sum !== manifest\.database\.sha256\)/.test(bk), 'sealed with a derived key, checksum verified before restore');

/* ------------------------------------------------ 2. the real thing */

const scratch = mkdtempSync(join(tmpdir(), 'fabrikka-m61-'));
const KEY = `m61-${Date.now()}`;
let out = '';
try {
  out = admin({ FABRIKKA_BACKUP_KEY: KEY }, 'backup', '--to', scratch);
} catch (err) {
  console.error(`backup failed: ${err.stderr ?? err.message}`);
  process.exit(1);
}
const file = out.match(/^wrote (.+)$/m)?.[1];
const manifest = JSON.parse(out.match(/^manifest (.+)$/m)?.[1] ?? 'null');
check(file && existsSync(file) && statSync(file).size > 64, `THE BACKUP IS ONE FILE: ${file?.split('/').pop()}`);
check(manifest && manifest.version === 1 && /^[0-9a-f]{64}$/.test(manifest.database.sha256) && manifest.database.bytes > 0, 'with a manifest: when, the dump size and checksum');
{
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(4);
  readSync(fd, head, 0, 4, 0);
  check(head.toString() === 'FBK1', 'the header says what it is, and nothing else is readable');
  const body = readFileSync(file);
  check(!body.includes('PGDMP') && !body.includes('CREATE TABLE'), '…the dump inside is not in the clear');
}
check(/fabrikka-.*\.fbk/.test(admin({}, 'backups', '--dir', scratch)), 'backups lists it');

const wrong = adminFails({ FABRIKKA_BACKUP_KEY: 'not-the-key', DATABASE_URL: DATABASE_URL }, 'restore', '--file', file);
check(wrong && /wrong passphrase/.test(wrong), 'A WRONG PASSPHRASE IS REFUSED before anything is touched');

const scratchDb = `fabrikka_m61_${Date.now()}`;
psql(adminUrl.href, `create database ${scratchDb}`);
const scratchUrl = new URL(DATABASE_URL);
scratchUrl.pathname = `/${scratchDb}`;
const restoredFiles = join(scratch, 'artifacts');
try {
  let restored = '';
  try {
    restored = admin({ FABRIKKA_BACKUP_KEY: KEY, DATABASE_URL: scratchUrl.href, ARTIFACT_DIR: restoredFiles }, 'restore', '--file', file);
  } catch (err) {
    console.error(`restore failed: ${err.stderr ?? err.message}`);
    failures++;
  }
  check(/^restored:/m.test(restored), 'THE ARCHIVE RESTORES INTO A FRESH DATABASE');
  for (const table of ['users', 'teams', 'sessions', 'participants', 'messages', 'audit_events']) {
    const a = psql(DATABASE_URL, `select count(*) from ${table}`);
    const b = psql(scratchUrl.href, `select count(*) from ${table}`);
    check(a === b, `${table}: ${b} row(s), as the source`);
  }
  const count = existsSync(restoredFiles) ? readdirSync(restoredFiles, { recursive: true }).filter((p) => statSync(join(restoredFiles, p)).isFile()).length : 0;
  check(count === manifest.artifacts.count, `${count} artifact file(s) restored, as the manifest says`);
  check(psql(scratchUrl.href, `select count(*) from audit_events where action = 'admin.restore'`) === '1', 'the restore left admin.restore in the restored trail');
  const again = adminFails({ FABRIKKA_BACKUP_KEY: KEY, DATABASE_URL: scratchUrl.href, ARTIFACT_DIR: restoredFiles }, 'restore', '--file', file);
  check(again && /already has tables/.test(again), 'A SECOND RESTORE WITHOUT --force IS REFUSED');
} finally {
  psql(adminUrl.href, `drop database if exists ${scratchDb} with (force)`);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nM61 checks passed');
process.exit(failures ? 1 : 0);
