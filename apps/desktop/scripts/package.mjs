/**
 * Build the app for this platform and the file an instance serves for the
 * installers (M34; every desktop since M57, ADR 0056): into dist-app/, the
 * file, its .sha256, a .meta.json, and apps.json regenerated from every
 * .meta.json there. macOS: a zipped .app (ditto keeps the bundle's signature,
 * symlinks and permissions; zip would not). Linux: the AppImage. Windows: the
 * NSIS installer (per user, silent with /S).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLATFORMS = {
  'darwin-arm64': { platform: 'darwin-arm64', bundle: 'app', file: 'Fabrikka-macos-arm64.zip' },
  'darwin-x64': { platform: 'darwin-x64', bundle: 'app', file: 'Fabrikka-macos-x64.zip' },
  'linux-x64': { platform: 'linux-x64', bundle: 'appimage', file: 'Fabrikka-linux-x64.AppImage' },
  'win32-x64': { platform: 'windows-x64', bundle: 'nsis', file: 'Fabrikka-windows-x64-setup.exe' },
};
const target = PLATFORMS[`${process.platform}-${process.arch}`];
if (!target) {
  console.error(`no app for ${process.platform}-${process.arch} (ADR 0056: macOS arm64 and x64, Linux x64, Windows x64)`);
  process.exit(1);
}
const run = (cmd, args, cwd = '.') => execFileSync(cmd, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
run('node', ['scripts/fetch-node.mjs']);
run('node', ['scripts/copy-client.mjs']);
run('npx', ['tauri', 'build', '--bundles', target.bundle]);

const bundles = 'src-tauri/target/release/bundle';
const out = join('dist-app', target.file);
mkdirSync('dist-app', { recursive: true });
rmSync(out, { force: true });
if (target.bundle === 'app') {
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(bundles, 'macos/Fabrikka.app'), out]);
} else {
  const dir = join(bundles, target.bundle);
  const built = readdirSync(dir).find((f) => (target.bundle === 'appimage' ? f.endsWith('.AppImage') : f.endsWith('.exe')));
  if (!built) throw new Error(`no ${target.bundle} bundle in ${dir}`);
  copyFileSync(join(dir, built), out);
}
const bytes = readFileSync(out);
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  ${target.file}\n`);
// The release tag names the version in CI; a local build is "dev".
const version = (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) || 'dev';
writeFileSync(`${out}.meta.json`, JSON.stringify({ platform: target.platform, file: target.file, sha256: sha, size: bytes.length, version }, null, 2) + '\n');
run('node', ['scripts/apps-manifest.mjs', 'dist-app']);
console.log(`packaged ${out} (${sha.slice(0, 12)}…)`);
