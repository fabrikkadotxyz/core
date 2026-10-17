/**
 * Fetch the Node the desktop app bundles (M34, ADR 0031; every desktop since
 * M57, ADR 0056), checked against a pinned SHA-256, and put its binary where
 * Tauri expects a sidecar: src-tauri/binaries/node-<target triple>[.exe].
 *
 * An official nodejs.org build, never the machine's own Node: Homebrew's links
 * against Homebrew libraries and wouldn't run on someone else's Mac.
 *
 * To move to a newer Node: change VERSION, and take the new hashes from
 * https://nodejs.org/dist/v<VERSION>/SHASUMS256.txt.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '24.21.0';
// Per platform: nodejs.org's archive name, its pinned SHA-256, Tauri's target triple, and the binary inside the archive.
export const TARGETS = {
  'darwin-arm64': {
    archive: `node-v${VERSION}-darwin-arm64.tar.gz`,
    sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    triple: 'aarch64-apple-darwin',
    inner: `node-v${VERSION}-darwin-arm64/bin/node`,
    exe: '',
  },
  'darwin-x64': {
    archive: `node-v${VERSION}-darwin-x64.tar.gz`,
    sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
    triple: 'x86_64-apple-darwin',
    inner: `node-v${VERSION}-darwin-x64/bin/node`,
    exe: '',
  },
  'linux-x64': {
    archive: `node-v${VERSION}-linux-x64.tar.gz`,
    sha256: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
    triple: 'x86_64-unknown-linux-gnu',
    inner: `node-v${VERSION}-linux-x64/bin/node`,
    exe: '',
  },
  'win32-x64': {
    archive: `node-v${VERSION}-win-x64.zip`,
    sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    triple: 'x86_64-pc-windows-msvc',
    inner: `node-v${VERSION}-win-x64/node.exe`,
    exe: '.exe',
  },
};

const target = TARGETS[`${process.platform}-${process.arch}`];
if (!target) {
  console.error(`no pinned Node for ${process.platform}-${process.arch} (ADR 0056: macOS arm64 and x64, Linux x64, Windows x64)`);
  process.exit(1);
}

const binaries = fileURLToPath(new URL('../src-tauri/binaries/', import.meta.url));
const dest = join(binaries, `node-${target.triple}${target.exe}`);
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
  // tar reads .tar.gz and .zip alike (bsdtar on macOS and Windows, GNU tar on Linux).
  execFileSync('tar', ['-xf', target.archive, target.inner], { cwd: work });
  mkdirSync(binaries, { recursive: true });
  copyFileSync(join(work, target.inner), dest);
  chmodSync(dest, 0o755);
  writeFileSync(stamp, target.sha256 + '\n');
  console.log(`node ${VERSION} → ${dest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
