/**
 * Build the app and the zip an instance serves for `install.sh --app` (M34):
 * dist-app/Fabrikka-macos-arm64.zip and its .sha256 beside it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('packaging is macOS on Apple Silicon only for now (ADR 0031)');
  process.exit(1);
}
const run = (cmd, args, cwd = '.') => execFileSync(cmd, args, { stdio: 'inherit', cwd });
run('node', ['scripts/fetch-node.mjs']);
run('node', ['scripts/copy-client.mjs']);
run('npx', ['tauri', 'build', '--bundles', 'app']);

const app = 'src-tauri/target/release/bundle/macos/Fabrikka.app';
const out = 'dist-app/Fabrikka-macos-arm64.zip';
mkdirSync('dist-app', { recursive: true });
rmSync(out, { force: true });
// ditto keeps the bundle's signature, symlinks and permissions intact; zip would not.
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, out]);
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, sha + '\n');
console.log(`packaged ${out} (${sha.slice(0, 12)}…)`);
