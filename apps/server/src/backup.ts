/**
 * Backups that restore (M61). One encrypted archive holds everything an
 * instance keeps: the database (pg_dump, custom format) and the artifact
 * files, with a manifest and checksums. `restoreBackup` takes it back into an
 * empty instance. docs/operations.md, "Backups".
 *
 * The archive is a gzipped tar, encrypted with AES-256-GCM under a key derived
 * (scrypt) from FABRIKKA_BACKUP_KEY. Layout: "FBK1" · 16-byte salt · 12-byte
 * nonce · ciphertext · 16-byte tag. The passphrase is never in the archive, so
 * a copy that leaks is just bytes; keep the passphrase, and the instance's
 * FABRIKKA_ENCRYPTION_KEY, somewhere other than the server.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export const MAGIC = Buffer.from('FBK1');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Days a scheduled backup is kept before the daily prune removes it. */
export const BACKUP_KEEP_DAYS = (() => {
  const n = Number(process.env.FABRIKKA_BACKUP_KEEP_DAYS ?? 30);
  return Number.isInteger(n) && n > 0 ? n : 30;
})();

export interface BackupManifest {
  version: 1;
  createdAt: string;
  publicUrl: string | null;
  database: { bytes: number; sha256: string; dumpedWith: string };
  artifacts: { count: number; bytes: number };
}

export class BackupError extends Error {}

function keyFrom(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Run a command to completion; its stderr is the error message when it fails. */
function run(cmd: string, args: string[], opts: { stdout?: NodeJS.WritableStream; stdin?: NodeJS.ReadableStream } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.stdin ? 'pipe' : 'ignore', opts.stdout ? 'pipe' : 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    child.stderr!.on('data', (d) => (err += d));
    if (opts.stdout) child.stdout!.pipe(opts.stdout);
    else child.stdout!.on('data', (d) => (out += d));
    if (opts.stdin) opts.stdin.pipe(child.stdin!);
    child.on('error', (e) => reject(new BackupError(`${cmd} could not start: ${e.message}. Is it installed?`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new BackupError(`${cmd} failed (${code}): ${err.trim()}`))));
  });
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function walk(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { count, bytes };
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    count++;
    bytes += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return { count, bytes };
}

export interface CreateOptions {
  databaseUrl: string;
  artifactDir: string;
  passphrase: string;
  /** The directory the archive is written to, named fabrikka-<instant>.fbk. */
  dir: string;
  publicUrl?: string | null;
}

/** Dump, bundle, encrypt. Returns the archive's path and its manifest. */
export async function createBackup(o: CreateOptions): Promise<{ file: string; manifest: BackupManifest; bytes: number }> {
  if (!o.passphrase) throw new BackupError('a passphrase is required (FABRIKKA_BACKUP_KEY)');
  const work = await mkdtemp(join(tmpdir(), 'fabrikka-backup-'));
  try {
    const dump = join(work, 'db.dump');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump, o.databaseUrl]);
    const dumpedWith = (await run('pg_dump', ['--version'])).trim();
    if (existsSync(o.artifactDir)) await cp(o.artifactDir, join(work, 'artifacts'), { recursive: true });
    else await mkdir(join(work, 'artifacts'));
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      publicUrl: o.publicUrl ?? null,
      database: { bytes: (await stat(dump)).size, sha256: await sha256File(dump), dumpedWith },
      artifacts: await walk(join(work, 'artifacts')),
    };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await mkdir(o.dir, { recursive: true });
    const file = join(o.dir, `fabrikka-${manifest.createdAt.replace(/[:.]/g, '-')}.fbk`);
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', keyFrom(o.passphrase, salt), nonce);
    const out = createWriteStream(file, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, salt, nonce]));
    const tar = spawn('tar', ['-cf', '-', '-C', work, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tarErr = '';
    tar.stderr.on('data', (d) => (tarErr += d));
    const tarDone = new Promise<void>((resolve, reject) =>
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new BackupError(`tar failed (${code}): ${tarErr.trim()}`)))),
    );
    // The tag comes out of the cipher after final(); the pipeline ends the
    // sink, so write the tag through a second, appending stream.
    await pipeline(tar.stdout, createGzip({ level: 6 }), cipher, out);
    await tarDone;
    const tag = cipher.getAuthTag();
    await new Promise<void>((resolve, reject) => {
      const tail = createWriteStream(file, { flags: 'a' });
      tail.on('error', reject);
      tail.end(tag, () => resolve());
    });
    return { file, manifest, bytes: (await stat(file)).size };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Decrypt and unpack an archive into a fresh temporary directory. The caller removes it. */
async function unpack(file: string, passphrase: string): Promise<{ work: string; manifest: BackupManifest }> {
  const size = (await stat(file)).size;
  const headerLen = MAGIC.length + SALT_BYTES + NONCE_BYTES;
  if (size < headerLen + TAG_BYTES) throw new BackupError('not a Fabrikka backup: too short');
  const header = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(TAG_BYTES);
  {
    const fh = await import('node:fs/promises').then((m) => m.open(file, 'r'));
    try {
      await fh.read(header, 0, headerLen, 0);
      await fh.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    } finally {
      await fh.close();
    }
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('not a Fabrikka backup: bad header');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const nonce = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), nonce);
  decipher.setAuthTag(tag);

  const work = await mkdtemp(join(tmpdir(), 'fabrikka-restore-'));
  const tar = spawn('tar', ['-xf', '-', '-C', work], { stdio: ['pipe', 'ignore', 'pipe'] });
  let tarErr = '';
  tar.stderr.on('data', (d) => (tarErr += d));
  const tarDone = new Promise<void>((resolve, reject) =>
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new BackupError(`tar failed (${code}): ${tarErr.trim()}`)))),
  );
  try {
    await pipeline(createReadStream(file, { start: headerLen, end: size - TAG_BYTES - 1 }), decipher, createGunzip(), tar.stdin);
    await tarDone;
  } catch (err) {
    await rm(work, { recursive: true, force: true });
    // A wrong key yields noise, which gunzip or tar reject before GCM's final
    // check gets a say; a damaged file fails the same ways. One answer for both.
    throw new BackupError(`wrong passphrase, or the archive is damaged (${(err as Error).message})`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(work, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch {
    await rm(work, { recursive: true, force: true });
    throw new BackupError('the archive has no readable manifest');
  }
  const sum = await sha256File(join(work, 'db.dump'));
  if (sum !== manifest.database.sha256) {
    await rm(work, { recursive: true, force: true });
    throw new BackupError('the database dump does not match its checksum');
  }
  return { work, manifest };
}

/** Read an archive's manifest without restoring anything. */
export async function readManifest(file: string, passphrase: string): Promise<BackupManifest> {
  const { work, manifest } = await unpack(file, passphrase);
  await rm(work, { recursive: true, force: true });
  return manifest;
}

export interface RestoreOptions {
  file: string;
  databaseUrl: string;
  artifactDir: string;
  passphrase: string;
  /** Whether the target database holds any Fabrikka table yet. */
  hasTables: () => Promise<boolean>;
  /** Replace what is there: pg_restore --clean, and artifacts overwritten. */
  force?: boolean;
}

/** Take an archive back into an empty instance (or, with force, over a started one). */
export async function restoreBackup(o: RestoreOptions): Promise<BackupManifest> {
  if (!o.passphrase) throw new BackupError('a passphrase is required (FABRIKKA_BACKUP_KEY)');
  const { work, manifest } = await unpack(o.file, o.passphrase);
  try {
    if ((await o.hasTables()) && !o.force) {
      throw new BackupError('the target database already has tables; restore into a fresh database, or pass --force to replace what is there');
    }
    const args = ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', o.databaseUrl];
    if (o.force) args.unshift('--clean', '--if-exists');
    await run('pg_restore', [...args, join(work, 'db.dump')]);
    await mkdir(o.artifactDir, { recursive: true });
    await cp(join(work, 'artifacts'), o.artifactDir, { recursive: true, force: true });
    return manifest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function listBackups(dir: string): Promise<{ file: string; bytes: number; modifiedAt: Date }[]> {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.fbk')) continue;
    const s = await stat(join(dir, name));
    out.push({ file: join(dir, name), bytes: s.size, modifiedAt: s.mtime });
  }
  return out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/** Remove archives older than keepDays. Never the newest one, whatever its age. */
export async function pruneBackups(dir: string, keepDays = BACKUP_KEEP_DAYS): Promise<number> {
  const all = await listBackups(dir);
  const cutoff = Date.now() - keepDays * 86_400_000;
  let n = 0;
  for (const b of all.slice(1)) {
    if (b.modifiedAt.getTime() < cutoff) {
      await rm(b.file, { force: true });
      n++;
    }
  }
  return n;
}
