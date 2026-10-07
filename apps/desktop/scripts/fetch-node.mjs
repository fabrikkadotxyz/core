/**
 * Fetch the Node the desktop app bundles (M34, ADR 0031), checked against a
 * pinned SHA-256, and put its binary where Tauri expects a sidecar:
 * src-tauri/binaries/node-<target triple>.
 *
 * An official nodejs.org build, never the machine's own Node: Homebrew's links
 * against Homebrew libraries and wouldn't run on someone else's Mac.
 *
 * To move to a newer Node: change VERSION, and take the new hash from
 * https://nodejs.org/dist/v<VERSION>/SHASUMS256.txt.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '24.21.0';
// Per platform: nodejs.org's archive name, its pinned SHA-256, and Tauri's target triple.
const TARGETS = {
  'darwin-arm64': {
    archive: `node-v${VERSION}-darwin-arm64.tar.gz`,
    sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    triple: 'aarch64-apple-darwin',
  },
};

const target = TARGETS[`${process.platform}-${process.arch}`];
if (!target) {
  console.error(`no pinned Node for ${process.platform}-${process.arch} yet (ADR 0031: macOS on Apple Silicon first)`);
  process.exit(1);
}

const dest = new URL(`../src-tauri/binaries/node-${target.triple}`, import.meta.url).pathname;
const stamp = `${dest}.version`;
if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === target.sha256) {
  console.log(`node ${VERSION} already in place`);
  process.exit(0);
}

const url = `https://nodejs.org/dist/v${VERSION}/${target.archive}`;
console.log(`downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== target.sha256) throw new Error(`checksum mismatch for ${target.archive}: refusing it`);

const work = mkdtempSync(join(tmpdir(), 'fabrikka-node-'));
try {
  writeFileSync(join(work, target.archive), bytes);
  const inner = `${target.archive.replace(/\.tar\.gz$/, '')}/bin/node`;
  execFileSync('tar', ['-xzf', target.archive, inner], { cwd: work });
  mkdirSync(new URL('../src-tauri/binaries/', import.meta.url), { recursive: true });
  copyFileSync(join(work, inner), dest);
  chmodSync(dest, 0o755);
  writeFileSync(stamp, target.sha256 + '\n');
  console.log(`node ${VERSION} → ${dest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
