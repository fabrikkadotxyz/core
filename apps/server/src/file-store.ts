/**
 * Where uploaded files live (M66, ADR 0060): on disk under ARTIFACT_DIR, or in
 * an S3-compatible bucket, as the operator chose with FABRIKKA_FILES. Both
 * stores hold the same keys, the content hash sharded `ab/cd/<hash>`, so
 * moving between them is a copy and the database never changes.
 *
 * Content-addressed and write-once: a key's bytes never change. A room's files
 * are never removed (another row may share them); only profile pictures are,
 * under avatars/ (ADR 0061). docs/operations.md, "Files".
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createS3Client, type S3Config } from './s3.ts';

export interface FileStore {
  kind: 'disk' | 's3';
  /** For logs and the admin CLI. Never includes a secret. */
  describe(): string;
  has(key: string): Promise<boolean>;
  get(key: string): Promise<Buffer | null>;
  /** Write unless the key is already there: the content is the name. */
  put(key: string, bytes: Buffer): Promise<void>;
  /** Every key in the store. */
  list(): AsyncIterable<string>;
  /** Profile pictures only (ADR 0061): a room's files are never removed. */
  remove(key: string): Promise<void>;
  /** Prove the store can be written and read. Throws with the reason. */
  check(): Promise<void>;
}

export class FileStoreError extends Error {}

/** A blob's key: its SHA-256, sharded two levels so no directory or listing holds everything. */
export function blobKey(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new FileStoreError(`not a content hash: ${hash}`);
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

/** A profile picture's key (ADR 0061): its own tree, the one that may be deleted from. */
export function avatarKey(hash: string): string {
  return `avatars/${blobKey(hash)}`;
}

/** The default directory: `.artifacts/` in the repository root. */
export const DEFAULT_DISK_DIR = process.env.ARTIFACT_DIR ?? join(process.cwd(), '..', '..', '.artifacts');

const CHECK_KEY = 'fabrikka-check';

export function diskStore(dir: string): FileStore {
  const path = (key: string) => join(dir, ...key.split('/'));
  return {
    kind: 'disk',
    describe: () => `disk at ${dir}`,
    has: async (key) => existsSync(path(key)),
    get: (key) => readFile(path(key)).catch(() => null),
    async put(key, bytes) {
      const p = path(key);
      // Identical content is already there; writing again risks a torn write for nothing.
      if (existsSync(p)) return;
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes, { mode: 0o600 });
    },
    async *list() {
      if (!existsSync(dir)) return;
      for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!e.isFile()) continue;
        const key = relative(dir, join(e.parentPath, e.name)).split(sep).join('/');
        if (key !== CHECK_KEY) yield key;
      }
    },
    async remove(key) {
      if (!key.startsWith('avatars/')) throw new FileStoreError(`only profile pictures are removed, not ${key}`);
      await rm(path(key), { force: true });
    },
    async check() {
      await mkdir(dir, { recursive: true });
    },
  };
}

export function s3Store(cfg: S3Config): FileStore {
  const s3 = createS3Client(cfg);
  return {
    kind: 's3',
    describe: s3.describe,
    has: (key) => s3.head(key),
    get: (key) => s3.get(key),
    async put(key, bytes) {
      if (await s3.head(key)) return;
      await s3.put(key, bytes);
    },
    async *list() {
      for await (const key of s3.list()) if (key !== CHECK_KEY) yield key;
    },
    async remove(key) {
      if (!key.startsWith('avatars/')) throw new FileStoreError(`only profile pictures are removed, not ${key}`);
      await s3.remove(key);
    },
    async check() {
      const probe = Buffer.from(`fabrikka ${new Date().toISOString()}\n`);
      try {
        await s3.put(CHECK_KEY, probe, 'text/plain');
        const back = await s3.get(CHECK_KEY);
        if (!back || !back.equals(probe)) throw new FileStoreError('wrote a check object but read back something else');
      } catch (err) {
        throw new FileStoreError(`${s3.describe()} does not answer: ${(err as Error).message.replace(/\.$/, '')}${hint(err as Error)}`);
      }
    },
  };
}

/** What a common S3 error usually means, in the operator's words. */
function hint(err: Error): string {
  const m = err.message;
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|403/.test(m)) return '. The bucket rejected the key: check FABRIKKA_S3_ACCESS_KEY_ID and FABRIKKA_S3_SECRET_ACCESS_KEY, and that the key may read and write this bucket.';
  if (/NoSuchBucket/.test(m)) return '. No such bucket: create it, or check FABRIKKA_S3_BUCKET.';
  if (/AuthorizationHeaderMalformed|region/i.test(m)) return '. Check FABRIKKA_S3_REGION (R2 takes "auto").';
  if (/could not reach/.test(m)) return '. Check FABRIKKA_S3_ENDPOINT.';
  return '';
}

type Env = Record<string, string | undefined>;

/** The S3 settings from the environment, or why they are incomplete. */
export function s3ConfigFromEnv(env: Env): S3Config {
  const missing = ['FABRIKKA_S3_BUCKET', 'FABRIKKA_S3_ACCESS_KEY_ID', 'FABRIKKA_S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new FileStoreError(`FABRIKKA_FILES=s3 needs ${missing.join(', ')} (docs/operations.md, "Files")`);
  const endpoint = env.FABRIKKA_S3_ENDPOINT?.trim() || null;
  if (endpoint && !/^https?:\/\//.test(endpoint)) throw new FileStoreError(`FABRIKKA_S3_ENDPOINT must be an http(s) URL, not "${endpoint}"`);
  const pathStyleRaw = env.FABRIKKA_S3_PATH_STYLE?.trim().toLowerCase();
  let prefix = env.FABRIKKA_S3_PREFIX?.trim().replace(/^\/+/, '') ?? '';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return {
    endpoint,
    bucket: env.FABRIKKA_S3_BUCKET!.trim(),
    region: env.FABRIKKA_S3_REGION?.trim() || 'us-east-1',
    accessKeyId: env.FABRIKKA_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.FABRIKKA_S3_SECRET_ACCESS_KEY!.trim(),
    prefix,
    pathStyle: pathStyleRaw ? ['1', 'true', 'yes'].includes(pathStyleRaw) : endpoint !== null,
  };
}

/** The store FABRIKKA_FILES names; `kind` overrides it (the CLI's copy). */
export function fileStoreFromEnv(env: Env = process.env, kind?: 'disk' | 's3'): FileStore {
  const chosen = kind ?? (env.FABRIKKA_FILES?.trim().toLowerCase() || 'disk');
  if (chosen === 'disk') return diskStore(env.ARTIFACT_DIR ?? DEFAULT_DISK_DIR);
  if (chosen === 's3') return s3Store(s3ConfigFromEnv(env));
  throw new FileStoreError(`FABRIKKA_FILES must be "disk" or "s3", not "${chosen}"`);
}

let configured: FileStore | null = null;

/** The instance's store, made once from the environment. */
export function files(): FileStore {
  configured ??= fileStoreFromEnv();
  return configured;
}
